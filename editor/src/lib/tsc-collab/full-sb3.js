/* eslint-disable valid-jsdoc */
/**
 * ID-preserving .sb3 / .sprite3 export for collaboration.
 *
 * A normal save compresses number/text inputs and variable reporters into
 * short arrays and drops their block IDs (TurboWarp's optimizer also renames
 * IDs). Anyone loading that file gets NEW random IDs, so later edits that
 * point at those blocks can't be matched up between computers.
 *
 * These exports write every block as a full object keyed by its real ID, which
 * the normal Scratch 3 loader reads back with the same IDs. The files are still
 * valid .sb3/.sprite3 files, just a bit bigger.
 */

import JSZip from '@turbowarp/jszip';

const INPUT_SAME_BLOCK_SHADOW = 1;
const INPUT_BLOCK_NO_SHADOW = 2;
const INPUT_DIFF_BLOCK_SHADOW = 3;

const serializeInputs = inputs => {
    const out = {};
    for (const name of Object.keys(inputs)) {
        const input = inputs[name];
        if (input.block === input.shadow) {
            out[name] = [INPUT_SAME_BLOCK_SHADOW, input.block];
        } else if (input.shadow === null || typeof input.shadow === 'undefined') {
            out[name] = [INPUT_BLOCK_NO_SHADOW, input.block];
        } else {
            out[name] = [INPUT_DIFF_BLOCK_SHADOW, input.block, input.shadow];
        }
    }
    return out;
};

const serializeFields = fields => {
    const out = {};
    for (const name of Object.keys(fields)) {
        const field = fields[name];
        out[name] = [field.value];
        if (Object.prototype.hasOwnProperty.call(field, 'id')) {
            out[name].push(field.id);
        }
    }
    return out;
};

/**
 * Block positions must be numbers in an .sb3 file, or nobody can load it.
 * They can arrive as text: Blockly's "create" events carry them that way, and
 * a block whose position then never changes keeps it.
 * @param {*} value a block's x or y
 * @returns {number} the same position as a number
 */
const coordinate = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
};

const serializeBlockFull = block => {
    const out = {
        opcode: block.opcode,
        next: block.next,
        parent: block.parent,
        inputs: serializeInputs(block.inputs),
        fields: serializeFields(block.fields),
        shadow: block.shadow,
        topLevel: !!block.topLevel
    };
    if (block.topLevel) {
        out.x = coordinate(block.x);
        out.y = coordinate(block.y);
    }
    if (block.mutation) out.mutation = block.mutation;
    if (block.comment) out.comment = block.comment;
    return out;
};

const serializeBlocksFull = blocks => {
    const out = {};
    for (const id of Object.keys(blocks)) {
        out[id] = serializeBlockFull(blocks[id]);
    }
    return out;
};

/** project.json text with every block ID intact. Runs synchronously. */
const fullProjectJSON = vm => {
    const json = JSON.parse(vm.toJSON(null, {allowOptimization: false}));
    // serialize() lists targets in the same order as this filter
    const originals = vm.runtime.targets.filter(target => target.isOriginal);
    json.targets.forEach((serialized, index) => {
        serialized.blocks = serializeBlocksFull(originals[index].blocks._blocks);
    });
    return JSON.stringify(json);
};

const SETTINGS_FILE = 'turboscratch-room.json';

/**
 * TurboWarp's FPS, interpolation, limits, compiler and stage size live outside
 * the project unless "store settings in project" is used, so send them along.
 */
const readSettings = vm => {
    const runtime = vm.runtime;
    // warpTimer is a per-person editor setting, not part of the project
    const compilerOptions = Object.assign({}, runtime.compilerOptions);
    delete compilerOptions.warpTimer;
    return {
        framerate: runtime.frameLoop.framerate,
        interpolation: runtime.interpolationEnabled,
        runtimeOptions: runtime.runtimeOptions,
        compilerOptions,
        stageWidth: runtime.stageWidth,
        stageHeight: runtime.stageHeight,
        hqPen: !!(vm.renderer && vm.renderer.useHighQualityRender)
    };
};

const applySettings = (vm, settings) => {
    if (!settings) return;
    const runtime = vm.runtime;
    if (settings.stageWidth !== runtime.stageWidth || settings.stageHeight !== runtime.stageHeight) {
        vm.setStageSize(settings.stageWidth, settings.stageHeight);
    }
    vm.setFramerate(settings.framerate);
    vm.setInterpolation(settings.interpolation);
    vm.setRuntimeOptions(settings.runtimeOptions);
    vm.setCompilerOptions(settings.compilerOptions);
    if (vm.renderer && typeof settings.hqPen === 'boolean') {
        vm.renderer.setUseHighQualityRender(settings.hqPen);
    }
};

/** Reads the room settings stored by saveFullProject, if any. */
const readSettingsFromProject = async buffer => {
    try {
        const zip = await JSZip.loadAsync(buffer);
        const file = zip.file(SETTINGS_FILE);
        if (!file) return null;
        return JSON.parse(await file.async('string'));
    } catch (e) {
        return null;
    }
};

/**
 * Whole project as an .sb3 ArrayBuffer. The project is read synchronously
 * when this is called; only the zipping happens later.
 */
const saveFullProject = vm => {
    const projectJSON = fullProjectJSON(vm);
    const settings = JSON.stringify(readSettings(vm));
    const zip = vm._saveProjectZip();
    zip.file('project.json', projectJSON, {compression: 'DEFLATE'});
    zip.file(SETTINGS_FILE, settings);
    return zip.generateAsync({
        type: 'arraybuffer',
        mimeType: 'application/x.scratch.sb3'
    });
};

/** One sprite as a .sprite3 ArrayBuffer with every block ID intact. */
const exportFullSprite = (vm, targetId) => {
    const target = vm.runtime.getTargetById(targetId);
    const json = JSON.parse(vm.toJSON(targetId, {allowOptimization: false}));
    json.blocks = serializeBlocksFull(target.blocks._blocks);
    const zip = new JSZip();
    zip.file('sprite.json', JSON.stringify(json));
    vm._addFileDescsToZip(vm.serializeAssets(targetId), zip);
    return zip.generateAsync({
        type: 'arraybuffer',
        mimeType: 'application/x.scratch.sprite3',
        compression: 'DEFLATE'
    });
};

export {
    saveFullProject,
    exportFullSprite,
    readSettingsFromProject,
    applySettings
};
