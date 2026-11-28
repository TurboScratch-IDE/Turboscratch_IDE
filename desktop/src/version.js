// Small version helpers for the update check. Release tags look like
// "v1.2.3" or "v1.3.0-beta.1". No Electron imports, so tests run in plain Node.

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} text e.g. "v1.2.3"
 * @returns {{numbers: number[], prerelease: string[]}|null}
 */
const parseVersion = text => {
    if (typeof text !== 'string') return null;
    const match = VERSION_PATTERN.exec(text.trim());
    if (!match) return null;
    return {
        numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] ? match[4].split('.') : []
    };
};

// Follows the semver rules: 1.0.0-beta < 1.0.0, and numeric parts of a
// pre-release compare as numbers (beta.2 < beta.10).
const comparePrerelease = (a, b) => {
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) return -1;
        if (i >= b.length) return 1;
        const aIsNumber = /^\d+$/.test(a[i]);
        const bIsNumber = /^\d+$/.test(b[i]);
        if (aIsNumber && bIsNumber) {
            const diff = Number(a[i]) - Number(b[i]);
            if (diff !== 0) return Math.sign(diff);
        } else if (aIsNumber !== bIsNumber) {
            return aIsNumber ? -1 : 1;
        } else if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    return 0;
};

/**
 * @returns {number} -1 if a is older than b, 1 if newer, 0 if the same.
 * Throws if either text is not a version.
 */
const compareVersions = (a, b) => {
    const parsedA = parseVersion(a);
    const parsedB = parseVersion(b);
    if (!parsedA || !parsedB) {
        throw new Error(`Not a version: ${parsedA ? b : a}`);
    }
    for (let i = 0; i < 3; i++) {
        const diff = parsedA.numbers[i] - parsedB.numbers[i];
        if (diff !== 0) return Math.sign(diff);
    }
    return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
};

/**
 * @returns {boolean} true only if latest is a real version newer than current
 */
const isNewerVersion = (latest, current) => {
    try {
        return compareVersions(latest, current) > 0;
    } catch (e) {
        return false;
    }
};

module.exports = {
    parseVersion,
    compareVersions,
    isNewerVersion
};
