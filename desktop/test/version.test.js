const test = require('node:test');
const assert = require('node:assert/strict');
const {compareVersions, isNewerVersion, parseVersion} = require('../src/version');

test('reads release tags', () => {
    assert.deepEqual(parseVersion('v1.2.3'), {numbers: [1, 2, 3], prerelease: []});
    assert.deepEqual(parseVersion('1.2.3-beta.1'), {numbers: [1, 2, 3], prerelease: ['beta', '1']});
    assert.deepEqual(parseVersion('1.2.3+build.5'), {numbers: [1, 2, 3], prerelease: []});
    assert.equal(parseVersion('1.2'), null);
    assert.equal(parseVersion('latest'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion(undefined), null);
});

test('compares numbers as numbers, not text', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
    assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
    assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
});

test('pre-releases come before the real release', () => {
    assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('isNewerVersion only says yes for a real, newer version', () => {
    assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
    assert.equal(isNewerVersion('v2.0.0', '1.9.9'), true);
    assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
    assert.equal(isNewerVersion('0.9.0', '1.0.0'), false);
    assert.equal(isNewerVersion('nightly', '1.0.0'), false);
    assert.equal(isNewerVersion('', '1.0.0'), false);
    assert.equal(isNewerVersion(undefined, '1.0.0'), false);
});
