// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@balancer-labs/v2-interfaces/contracts/liquidity-mining/IAuthorizerAdaptorEntrypoint.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IAuthorizer.sol";

import "@balancer-labs/v2-solidity-utils/contracts/helpers/InputHelpers.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/Address.sol";
import "./TimelockExecutionHelper.sol";
import "./TimelockAuthorizerManagement.sol";

/**
 * See ITimelockAuthorizer.
 */
contract TimelockAuthorizer is IAuthorizer, TimelockAuthorizerManagement {
    // solhint-disable-next-line const-name-snakecase
    uint256 private constant _MAX_DELAY = 2 * (365 days);

    // solhint-disable-next-line const-name-snakecase
    uint256 private constant _MINIMUM_CHANGE_DELAY_EXECUTION_DELAY = 5 days;

    IAuthorizerAdaptorEntrypoint private immutable _authorizerAdaptorEntrypoint;
    IAuthorizerAdaptor private immutable _authorizerAdaptor;

    // action id => delay
    mapping(bytes32 => uint256) private _grantDelays;
    // action id => delay
    mapping(bytes32 => uint256) private _revokeDelays;

    // External permissions
    // actionId -> account -> where -> isGranted
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _isPermissionGranted;
    // actionId -> delay (in seconds)
    mapping(bytes32 => uint256) private _delaysPerActionId;

    constructor(
        address initialRoot,
        address nextRoot,
        IAuthorizerAdaptorEntrypoint authorizerAdaptorEntrypoint,
        uint256 rootTransferDelay
    ) TimelockAuthorizerManagement(initialRoot, nextRoot, authorizerAdaptorEntrypoint.getVault(), rootTransferDelay) {
        _authorizerAdaptor = authorizerAdaptorEntrypoint.getAuthorizerAdaptor();
        _authorizerAdaptorEntrypoint = authorizerAdaptorEntrypoint;
    }

    // solhint-disable-next-line func-name-mixedcase
    function MAX_DELAY() public pure override returns (uint256) {
        return _MAX_DELAY;
    }

    // solhint-disable-next-line func-name-mixedcase
    function MINIMUM_CHANGE_DELAY_EXECUTION_DELAY() public pure override returns (uint256) {
        return _MINIMUM_CHANGE_DELAY_EXECUTION_DELAY;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function getActionIdDelay(bytes32 actionId) external view override returns (uint256) {
        return _delaysPerActionId[actionId];
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function getActionIdGrantDelay(bytes32 actionId) external view override returns (uint256) {
        return _grantDelays[actionId];
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function getActionIdRevokeDelay(bytes32 actionId) external view override returns (uint256) {
        return _revokeDelays[actionId];
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function isPermissionGrantedOnTarget(
        bytes32 actionId,
        address account,
        address where
    ) external view override returns (bool) {
        return _isPermissionGranted[actionId][account][where];
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function hasPermission(
        bytes32 actionId,
        address account,
        address where
    ) public view override returns (bool) {
        return _isPermissionGranted[actionId][account][where] || _isPermissionGranted[actionId][account][EVERYWHERE()];
    }

    /**
     * @inheritdoc IAuthorizer
     */
    function canPerform(
        bytes32 actionId,
        address account,
        address where
    ) public view override returns (bool) {
        if (msg.sender == address(_authorizerAdaptor)) {
            // The situation where the caller is the `AuthorizerAdaptor` is a special case, as due to a bug it can be
            // tricked into passing an incorrect `actionId` value, potentially resulting in escalation of privileges.
            //
            // To remedy this we force all calls to the `AuthorizerAdaptor` to be made through a singleton entrypoint
            // contract, called the `AuthorizerAdaptorEntrypoint`. This contract correctly checks whether `account` can
            // perform `actionId` on `where`, and then forwards the call onto the `AuthorizerAdaptor` to execute.
            //
            // The authorizer then rejects calls to the `AuthorizerAdaptor` which aren't made through the entrypoint,
            // and approves all calls made through it (since the entrypoint will have already performed any necessary
            // permission checks).
            return account == address(_authorizerAdaptorEntrypoint);
        }

        // Actions with no delay can only be performed by accounts that have the associated permission.
        // However, actions with a non-zero delay cannot be performed by permissioned accounts: they can only be made by
        // the TimelockAuthorizerExecutionHelper, which works alongisde the TimelockAuthorizer itself to ensure that
        // executions have been properly scheduled in advance by an authorized party via the `schedule` function.
        return
            _delaysPerActionId[actionId] == 0
                ? hasPermission(actionId, account, where)
                : account == getTimelockExecutionHelper();
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function setDelay(bytes32 actionId, uint256 delay) external override onlyScheduled {
        // If changing the `setAuthorizer` delay itself, then we don't need to compare it to its current value for
        // validity.
        if (actionId != IAuthentication(getVault()).getActionId(IVault.setAuthorizer.selector)) {
            require(_isDelayShorterThanSetAuthorizer(delay), "DELAY_EXCEEDS_SET_AUTHORIZER");
        }

        _delaysPerActionId[actionId] = delay;
        emit ActionDelaySet(actionId, delay);
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function setGrantDelay(bytes32 actionId, uint256 delay) external override onlyScheduled {
        require(_isDelayShorterThanSetAuthorizer(delay), "DELAY_EXCEEDS_SET_AUTHORIZER");

        _grantDelays[actionId] = delay;
        emit GrantDelaySet(actionId, delay);
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function setRevokeDelay(bytes32 actionId, uint256 delay) external override onlyScheduled {
        require(_isDelayShorterThanSetAuthorizer(delay), "DELAY_EXCEEDS_SET_AUTHORIZER");

        _revokeDelays[actionId] = delay;
        emit RevokeDelaySet(actionId, delay);
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function scheduleDelayChange(
        bytes32 actionId,
        uint256 newDelay,
        address[] memory executors
    ) external override returns (uint256) {
        require(isRoot(msg.sender), "SENDER_IS_NOT_ROOT");
        require(newDelay <= MAX_DELAY(), "DELAY_TOO_LARGE");

        uint256 executionDelay = _getDelayChangeExecutionDelay(_delaysPerActionId[actionId], newDelay);

        bytes memory data = abi.encodeWithSelector(this.setDelay.selector, actionId, newDelay);
        // TODO: add custom event

        // Since this can only be called by root, which is always a canceler for all scheduled executions, we don't
        // bother creating any new cancelers.
        uint256 scheduledExecutionId = _scheduleWithDelay(address(this), data, executionDelay, executors);
        emit DelayChangeScheduled(actionId, newDelay, scheduledExecutionId);
        return scheduledExecutionId;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function scheduleGrantDelayChange(
        bytes32 actionId,
        uint256 newDelay,
        address[] memory executors
    ) external override returns (uint256) {
        require(isRoot(msg.sender), "SENDER_IS_NOT_ROOT");
        require(newDelay <= MAX_DELAY(), "DELAY_TOO_LARGE");

        uint256 executionDelay = _getDelayChangeExecutionDelay(_grantDelays[actionId], newDelay);

        bytes memory data = abi.encodeWithSelector(this.setGrantDelay.selector, actionId, newDelay);

        // Since this can only be called by root, which is always a canceler for all scheduled executions, we don't
        // bother creating any new cancelers.
        uint256 scheduledExecutionId = _scheduleWithDelay(address(this), data, executionDelay, executors);
        emit GrantDelayChangeScheduled(actionId, newDelay, scheduledExecutionId);
        return scheduledExecutionId;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function scheduleRevokeDelayChange(
        bytes32 actionId,
        uint256 newDelay,
        address[] memory executors
    ) external override returns (uint256) {
        require(isRoot(msg.sender), "SENDER_IS_NOT_ROOT");
        require(newDelay <= MAX_DELAY(), "DELAY_TOO_LARGE");

        uint256 executionDelay = _getDelayChangeExecutionDelay(_revokeDelays[actionId], newDelay);

        bytes memory data = abi.encodeWithSelector(this.setRevokeDelay.selector, actionId, newDelay);

        // Since this can only be called by root, which is always a canceler for all scheduled executions, we don't
        // bother creating any new cancelers.
        uint256 scheduledExecutionId = _scheduleWithDelay(address(this), data, executionDelay, executors);
        emit RevokeDelayChangeScheduled(actionId, newDelay, scheduledExecutionId);
        return scheduledExecutionId;
    }

    function scheduleAdaptorAction(
        address where,
        bytes memory data,
        address[] memory executors
    ) external returns (uint256) {
        return
            _schedule(
                where,
                address(_authorizerAdaptorEntrypoint),
                abi.encodeWithSelector(_authorizerAdaptorEntrypoint.performAction.selector, where, data),
                executors
            );
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function schedule(
        address where,
        bytes memory data,
        address[] memory executors
    ) external override returns (uint256) {
        return _schedule(where, where, data, executors);
    }

    function _schedule(
        address where,
        address entrypoint,
        bytes memory data,
        address[] memory executors
    ) internal returns (uint256) {
        // Allowing scheduling arbitrary calls into the TimelockAuthorizer is dangerous.
        //
        // It is expected that only the `root` account can initiate a root transfer as this condition is enforced
        // by the `scheduleRootChange` function which is the expected method of scheduling a call to `setPendingRoot`.
        // If a call to `setPendingRoot` could be scheduled using this function as well as `scheduleRootChange` then
        // accounts other than `root` could initiate a root transfer (provided they had the necessary permission).
        // Similarly, `setDelay` can only be called if scheduled via `scheduleDelayChange`.
        //
        // For this reason we disallow this function from scheduling calls to functions on the Authorizer to ensure that
        // these actions can only be scheduled through specialised functions.
        require(where != address(this), "CANNOT_SCHEDULE_AUTHORIZER_ACTIONS");

        // We also disallow the TimelockExecutionHelper from attempting to call into itself. Otherwise the above
        // protection could be bypassed by wrapping a call to `setPendingRoot` inside of a call, causing the
        // TimelockExecutionHelper to reenter itself, essentially hiding the fact that `where == address(this)` inside
        // `data`.
        //
        // Note: The TimelockExecutionHelper only accepts calls from the TimelockAuthorizer (i.e. not from itself) so
        // this scenario should be impossible: but this check is cheap so we enforce it here as well anyway.
        require(where != getTimelockExecutionHelper(), "ATTEMPTING_EXECUTION_HELPER_REENTRANCY");
        require(entrypoint == where || entrypoint == address(_authorizerAdaptorEntrypoint), "INVALID_ENTRYPOINT");

        // We require data to have a function selector
        require(data.length >= 4, "DATA_TOO_SHORT");
        // The bytes4 type is left-aligned and padded with zeros: we make use of that property to build the selector
        bytes4 selector = bytes4(data[0]) | (bytes4(data[1]) >> 8) | (bytes4(data[2]) >> 16) | (bytes4(data[3]) >> 24);

        bytes32 actionId = IAuthentication(entrypoint).getActionId(selector);
        require(hasPermission(actionId, msg.sender, where), "SENDER_DOES_NOT_HAVE_PERMISSION");

        uint256 delay = _delaysPerActionId[actionId];
        require(delay > 0, "DELAY_IS_NOT_SET");

        uint256 scheduledExecutionId = _scheduleWithDelay(entrypoint, data, delay, executors);

        emit ExecutionScheduled(actionId, scheduledExecutionId);

        // Accounts that schedule executions are automatically made cancelers for them, so that they can manage their
        // actions. We check that they are not already a canceler since e.g. root may schedule executions (and root is
        // always a global canceler).
        if (!isCanceler(scheduledExecutionId, msg.sender)) {
            _addCanceler(scheduledExecutionId, msg.sender);
        }
        return scheduledExecutionId;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function grantPermission(
        bytes32 actionId,
        address account,
        address where
    ) external override {
        if (_grantDelays[actionId] == 0) {
            require(isGranter(actionId, msg.sender, where), "SENDER_IS_NOT_GRANTER");
        } else {
            // Some actions may have delays associated with granting them - these permissions cannot be granted
            // directly, even if the caller is a granter, and must instead be scheduled for future execution via
            // `scheduleGrantPermission`.
            require(msg.sender == getTimelockExecutionHelper(), "GRANT_MUST_BE_SCHEDULED");
        }

        require(!hasPermission(actionId, account, where), "PERMISSION_ALREADY_GRANTED");
        // Note that it is possible for `account` to have permission for an `actionId` in some specific `where`, and
        // then be granted permission over `EVERYWHERE`, resulting in 'duplicate' permissions. This is not an issue per
        // se, but removing these permissions status will require undoing these actions in inverse order.
        // To avoid these issues, it is recommended to revoke any prior prermissions over specific contracts before
        // granting an account a global permissions.

        _isPermissionGranted[actionId][account][where] = true;
        emit PermissionGranted(actionId, account, where);
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function scheduleGrantPermission(
        bytes32 actionId,
        address account,
        address where,
        address[] memory executors
    ) external override returns (uint256) {
        require(isGranter(actionId, msg.sender, where), "SENDER_IS_NOT_GRANTER");

        uint256 delay = _grantDelays[actionId];
        require(delay > 0, "ACTION_HAS_NO_GRANT_DELAY");

        bytes memory data = abi.encodeWithSelector(this.grantPermission.selector, actionId, account, where);

        uint256 scheduledExecutionId = _scheduleWithDelay(address(this), data, delay, executors);
        emit GrantPermissionScheduled(actionId, account, where, scheduledExecutionId);
        // Granters that schedule executions are automatically made cancelers for them, so that they can manage their
        // action. We check that they are not already a canceler since e.g. root may schedule grants (and root is
        // always a global canceler).
        if (!isCanceler(scheduledExecutionId, msg.sender)) {
            _addCanceler(scheduledExecutionId, msg.sender);
        }
        return scheduledExecutionId;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function revokePermission(
        bytes32 actionId,
        address account,
        address where
    ) external override {
        if (_revokeDelays[actionId] == 0) {
            require(isRevoker(msg.sender, where), "SENDER_IS_NOT_REVOKER");
        } else {
            // Some actions may have delays associated with revoking them - these permissions cannot be revoked
            // directly, even if the caller is a revoker, and must instead be scheduled for future execution via
            // `scheduleRevokePermission`.
            require(msg.sender == getTimelockExecutionHelper(), "REVOKE_MUST_BE_SCHEDULED");
        }
        _revokePermission(actionId, account, where);
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function scheduleRevokePermission(
        bytes32 actionId,
        address account,
        address where,
        address[] memory executors
    ) external override returns (uint256) {
        require(isRevoker(msg.sender, where), "SENDER_IS_NOT_REVOKER");

        uint256 delay = _revokeDelays[actionId];
        require(delay > 0, "ACTION_HAS_NO_REVOKE_DELAY");

        bytes memory data = abi.encodeWithSelector(this.revokePermission.selector, actionId, account, where);

        uint256 scheduledExecutionId = _scheduleWithDelay(address(this), data, delay, executors);
        emit RevokePermissionScheduled(actionId, account, where, scheduledExecutionId);
        // Revokers that schedule executions are automatically made cancelers for them, so that they can manage their
        // action. We check that they are not already a canceler since e.g. root may schedule revokes (and root is
        // always a global canceler).
        if (!isCanceler(scheduledExecutionId, msg.sender)) {
            _addCanceler(scheduledExecutionId, msg.sender);
        }
        return scheduledExecutionId;
    }

    /**
     * @inheritdoc ITimelockAuthorizer
     */
    function renouncePermission(bytes32 actionId, address where) external override {
        _revokePermission(actionId, msg.sender, where);
    }

    /**
     * @dev Revokes a permission from `account` for `actionId` at `where` address.
     *
     * This performs no permission checks on `msg.sender` of any kind. The caller of this function should perform
     * any appropriate checks.
     */
    function _revokePermission(
        bytes32 actionId,
        address account,
        address where
    ) private {
        require(hasPermission(actionId, account, where), "PERMISSION_NOT_GRANTED");

        if (_isPermissionGranted[actionId][account][EVERYWHERE()]) {
            // If an account has global permission, then it must explicitly lose this global privilege. This prevents
            // scenarios where an account has their permission revoked over a specific contract, but they can still
            // use it (including in that contract!) because they have global permission.
            // There's an edge case in which an account could have both specific and global permission, and still have
            // permission over some contracts after losing global privilege. This is considered an unlikely scenario,
            // and would require manual removal of the specific permissions even after removal of the global one.
            require(where == EVERYWHERE(), "ACCOUNT_HAS_GLOBAL_PERMISSION");
        }

        _isPermissionGranted[actionId][account][where] = false;
        emit PermissionRevoked(actionId, account, where);
    }

    function _getDelayChangeExecutionDelay(uint256 currentDelay, uint256 newDelay) private pure returns (uint256) {
        // The delay change is scheduled so that it's never possible to execute an action in a shorter time than the
        // current delay.
        //
        // If we're reducing the action's delay then we must first wait for the difference between the two delays.
        // This means that if we immediately schedule the action for execution once the delay is reduced, then
        // these two delays combined will result in the original delay.
        // For example, if an action's delay is 20 days and we wish to reduce it to 5 days, we need to wait 15 days
        // before the new shorter delay is effective, to make it impossible to execute the action before the full
        // original 20-day delay period has elapsed.
        //
        // If we're increasing the delay on an action, we could in principle execute this change immediately, since the
        // larger delay would fulfill the original constraint imposed by the first delay.
        // For example, if we wish to increase the delay of an action from 5 days to 20 days, there is no need to wait
        // as it would not be possible to execute the action with a delay shorter than the initial 5 days at any point.
        //
        // However, not requiring a delay to increase an action's delay creates an issue: it would be possible to
        // effectively disable actions by setting huge delays (e.g. 2 years) for them. Because of this, all delay
        // changes are subject to a minimum execution delay, to allow for proper scrutiny of these potentially
        // dangerous actions.

        return
            newDelay < currentDelay
                ? Math.max(currentDelay - newDelay, MINIMUM_CHANGE_DELAY_EXECUTION_DELAY())
                : MINIMUM_CHANGE_DELAY_EXECUTION_DELAY();
    }

    /**
     * @notice Checks if a `delay` is shorter than `setAuthorizer` action delay.
     *
     * @dev No delay can be greater than the current delay for changing the Authorizer itself (`IVault.setAuthorizer`).
     * Otherwise, it'd be possible to execute the action with a shorter delay by simply replacing
     * the TimelockAuthorizer with a different contract that didn't enforce these delays.
     * Note that it is still possible for an action to end up with a delay longer than `setAuthorizer` if
     * e.g. `setAuthorizer`'s delay was to ever be decreased, but this is not expected to happen. The following
     * check is therefore simply a way to try to prevent user error, but is not infallible.
     */
    function _isDelayShorterThanSetAuthorizer(uint256 delay) private view returns (bool) {
        bytes32 setAuthorizerActionId = IAuthentication(getVault()).getActionId(IVault.setAuthorizer.selector);
        return delay <= _delaysPerActionId[setAuthorizerActionId];
    }
}
