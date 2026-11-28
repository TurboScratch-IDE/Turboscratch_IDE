// Makes the app icons in desktop/build/ from branding/turboscratch-icon.svg:
//   build/icon.png  1024x1024 for macOS, with the transparent margin macOS
//                   icons have (the artwork fills 824x824, like Apple's grid)
//   build/icon.ico  16 to 256 px for Windows, artwork filling the square
// Run with: npm run make-icons
// It uses Electron to draw the SVG, so it needs no other image tools.

const {app, BrowserWindow} = require('electron');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.resolve(__dirname, '..', '..', 'branding', 'turboscratch-icon.svg');
const OUT_DIR = path.resolve(__dirname, '..', 'build');
const MAC_SIZE = 1024;
const MAC_ARTWORK = 824;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Runs inside the hidden page: draws the SVG at each size and returns
// PNG files and raw RGBA pixels, both as base64.
const renderInPage = async (svgDataUrl, jobs) => {
    const image = new Image();
    image.src = svgDataUrl;
    await image.decode();
    const toBase64 = bytes => {
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
    };
    return jobs.map(({size, artwork}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        const offset = (size - artwork) / 2;
        ctx.drawImage(image, offset, offset, artwork, artwork);
        const rgba = ctx.getImageData(0, 0, size, size).data;
        return {
            size,
            png: canvas.toDataURL('image/png').split(',')[1],
            rgba: toBase64(new Uint8Array(rgba.buffer))
        };
    });
};

// An .ico file: small sizes as 32-bit bitmaps (every Windows tool reads
// those), 256 px as PNG (the standard way for the big size).
const makeIco = images => {
    const entries = images.map(({size, png, rgba}) => {
        if (size >= 256) {
            return {size, data: png};
        }
        // Bitmap rows go bottom to top, in BGRA order, followed by a
        // 1-bit "AND" mask that is ignored when there is alpha.
        const header = Buffer.alloc(40);
        header.writeUInt32LE(40, 0);
        header.writeInt32LE(size, 4);
        header.writeInt32LE(size * 2, 8);
        header.writeUInt16LE(1, 12);
        header.writeUInt16LE(32, 14);
        const pixels = Buffer.alloc(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const from = ((y * size) + x) * 4;
                const to = (((size - 1 - y) * size) + x) * 4;
                pixels[to] = rgba[from + 2];
                pixels[to + 1] = rgba[from + 1];
                pixels[to + 2] = rgba[from];
                pixels[to + 3] = rgba[from + 3];
            }
        }
        const maskRowBytes = Math.ceil(size / 32) * 4;
        const mask = Buffer.alloc(maskRowBytes * size);
        return {size, data: Buffer.concat([header, pixels, mask])};
    });

    const directory = Buffer.alloc(6 + (16 * entries.length));
    directory.writeUInt16LE(0, 0);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(entries.length, 4);
    let offset = directory.length;
    entries.forEach(({size, data}, i) => {
        const at = 6 + (16 * i);
        directory.writeUInt8(size >= 256 ? 0 : size, at);
        directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
        directory.writeUInt8(0, at + 2);
        directory.writeUInt8(0, at + 3);
        directory.writeUInt16LE(1, at + 4);
        directory.writeUInt16LE(32, at + 6);
        directory.writeUInt32LE(data.length, at + 8);
        directory.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    return Buffer.concat([directory, ...entries.map(entry => entry.data)]);
};

app.whenReady().then(async () => {
    const svg = fs.readFileSync(SVG_PATH);
    const svgDataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;
    const jobs = [
        {size: MAC_SIZE, artwork: MAC_ARTWORK},
        ...ICO_SIZES.map(size => ({size, artwork: size}))
    ];

    const win = new BrowserWindow({show: false, webPreferences: {sandbox: true}});
    await win.loadURL('about:blank');
    const results = await win.webContents.executeJavaScript(
        `(${renderInPage.toString()})(${JSON.stringify(svgDataUrl)}, ${JSON.stringify(jobs)})`
    );
    win.destroy();

    const images = results.map(({size, png, rgba}) => ({
        size,
        png: Buffer.from(png, 'base64'),
        rgba: Buffer.from(rgba, 'base64')
    }));

    fs.mkdirSync(OUT_DIR, {recursive: true});
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images[0].png);
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), makeIco(images.slice(1)));
    console.log(`Wrote ${path.join(OUT_DIR, 'icon.png')} and icon.ico`);
    app.quit();
}).catch(err => {
    console.error(err);
    app.exit(1);
});
