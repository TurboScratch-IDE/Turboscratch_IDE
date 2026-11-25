/* eslint-disable react/jsx-no-bind, valid-jsdoc */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect, useState} from 'react';
import ReactDOM from 'react-dom';
import {attachConsole} from '../../lib/tsc-console/console';
import ConsolePanel from './console-panel.jsx';
import consoleIcon from './console-icon.svg';
import styles from './console-button.css';

/**
 * The "Console" menu bar button. It opens the debugger console, a list of
 * what the project does while it runs. The console starts recording as soon
 * as the editor opens, so it has something to show the first time it's opened.
 */
const ConsoleButton = ({className, isFullScreen, labelClassName, vm}) => {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        attachConsole(vm);
    }, [vm]);

    return (
        <React.Fragment>
            <div
                className={classNames(className, styles.consoleButton, {[styles.open]: open})}
                title="Debugger console: what your project does while it runs"
                onClick={() => setOpen(!open)}
            >
                <img
                    src={consoleIcon}
                    draggable={false}
                    width={20}
                    height={20}
                />
                <span className={labelClassName}>{'Console'}</span>
            </div>
            {/* Hidden (not closed) while the stage is full screen. */}
            {open && !isFullScreen && ReactDOM.createPortal(
                <ConsolePanel onClose={() => setOpen(false)} />,
                document.body
            )}
        </React.Fragment>
    );
};

ConsoleButton.propTypes = {
    className: PropTypes.string,
    isFullScreen: PropTypes.bool,
    labelClassName: PropTypes.string,
    vm: PropTypes.object
};

export default ConsoleButton;
