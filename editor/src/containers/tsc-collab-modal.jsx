/* eslint-disable react/jsx-no-bind */
import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import CollabModalComponent from '../components/tsc-collab/collab-modal.jsx';
import {closeCollabModal} from '../reducers/modals';
import {getIsShowingProject} from '../reducers/project-state';
import {getCollabSession} from '../lib/tsc-collab/session';
import {readInviteFromUrl} from '../lib/tsc-collab/settings';

const session = getCollabSession();

const TSCCollabModal = props => {
    const invite = readInviteFromUrl();
    // In the room list, a new room is shown with the project's name.
    const handleJoin = params => session.join(Object.assign({title: props.projectTitle}, params));
    return (
        <CollabModalComponent
            initialRoom={invite ? invite.room : null}
            initialServer={invite ? invite.serverUrl : null}
            projectChanged={props.projectChanged}
            projectReady={props.projectReady}
            onClose={props.onClose}
            onJoin={handleJoin}
            onLeave={() => {
                session.leave();
                props.onClose();
            }}
            onResync={() => session.resync()}
            onSendChat={text => session.sendChat(text)}
            onSetListed={listed => session.setListed(listed)}
            onChatRead={() => session.markChatRead()}
        />
    );
};

TSCCollabModal.propTypes = {
    onClose: PropTypes.func.isRequired,
    projectChanged: PropTypes.bool,
    projectReady: PropTypes.bool,
    projectTitle: PropTypes.string
};

const mapStateToProps = state => ({
    // Unsaved changes: joining a room from the list asks first.
    projectChanged: state.scratchGui.projectChanged,
    projectTitle: state.scratchGui.projectTitle,
    // Joining before the editor finished loading its first project would let
    // that project overwrite the room's project.
    projectReady: getIsShowingProject(state.scratchGui.projectState.loadingState)
});

const mapDispatchToProps = dispatch => ({
    onClose: () => dispatch(closeCollabModal())
});

export default connect(
    mapStateToProps,
    mapDispatchToProps
)(TSCCollabModal);
