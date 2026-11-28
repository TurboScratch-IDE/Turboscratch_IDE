// The app's own menu (the editor's File, Edit and other menus are inside the page).

const {Menu} = require('electron');

/**
 * @param {object} actions
 * @param {boolean} actions.isMac
 * @param {boolean} actions.isDev true when running from source (npm start)
 * @param {() => void} actions.newWindow
 * @param {() => void} actions.showAbout
 * @param {() => void} actions.checkForUpdates
 * @param {(url: string) => void} actions.openExternal
 * @param {{website: string, source: string, license: string}} actions.links
 */
const buildMenu = ({isMac, isDev, newWindow, showAbout, checkForUpdates, openExternal, links}) => {
    const separator = {type: 'separator'};

    const viewMenu = {
        label: 'View',
        submenu: [
            // Reload would throw away unsaved work and the developer tools are
            // only useful while working on the app, so both stay out of releases.
            ...(isDev ? [
                {role: 'reload'},
                {role: 'forceReload'},
                {role: 'toggleDevTools'},
                separator
            ] : []),
            {role: 'resetZoom'},
            {role: 'zoomIn'},
            {role: 'zoomOut'},
            separator,
            {role: 'togglefullscreen'}
        ]
    };

    const helpItems = [
        {label: 'TurboScratch IDE Website', click: () => openExternal(links.website)},
        {label: 'Source Code (GPL-3.0)', click: () => openExternal(links.source)},
        {label: 'License', click: () => openExternal(links.license)},
        separator,
        {label: 'Check for Updates…', click: checkForUpdates}
    ];

    if (isMac) {
        return Menu.buildFromTemplate([
            {
                label: 'TurboScratch IDE',
                submenu: [
                    {label: 'About TurboScratch IDE', click: showAbout},
                    {label: 'Check for Updates…', click: checkForUpdates},
                    separator,
                    {role: 'services'},
                    separator,
                    {role: 'hide'},
                    {role: 'hideOthers'},
                    {role: 'unhide'},
                    separator,
                    {role: 'quit'}
                ]
            },
            {
                label: 'File',
                submenu: [
                    {label: 'New Window', accelerator: 'Cmd+N', click: newWindow},
                    separator,
                    {role: 'close'}
                ]
            },
            // On macOS copy, paste and undo shortcuts only work in text boxes
            // when the menu has these items.
            {role: 'editMenu'},
            viewMenu,
            {role: 'windowMenu'},
            {role: 'help', submenu: helpItems}
        ]);
    }

    // Windows: no File or Edit menu here, because the editor shows its own
    // File and Edit menus right below, and two of each would be confusing.
    // Copy and paste shortcuts work on Windows without menu items.
    return Menu.buildFromTemplate([
        viewMenu,
        {
            label: 'Window',
            submenu: [
                {label: 'New Window', click: newWindow},
                {role: 'minimize'},
                {role: 'close'},
                separator,
                {role: 'quit'}
            ]
        },
        {
            label: 'Help',
            submenu: [
                ...helpItems,
                separator,
                {label: 'About TurboScratch IDE', click: showAbout}
            ]
        }
    ]);
};

module.exports = {
    buildMenu
};
