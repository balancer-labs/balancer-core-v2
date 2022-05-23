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

import "@balancer-labs/v2-interfaces/contracts/vault/IBasicAuthorizer.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";

import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

import "./TimelockAuthorizer.sol";

contract TimelockAuthorizerMigrator {
    bytes32 public constant WHATEVER = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    address public constant EVERYWHERE = address(-1);
    uint256 public constant CHANGE_ROOT_DELAY = 7 days;
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    IVault public immutable vault;
    address public immutable root;
    IBasicAuthorizer public immutable oldAuthorizer;
    TimelockAuthorizer public immutable newAuthorizer;

    uint256 public migratedRoles;
    RoleData[] public rolesData;
    uint256 public rootChangeExecutionId;

    struct RoleData {
        address grantee;
        bytes32 role;
        address target;
    }

    constructor(
        IVault _vault,
        address _root,
        IBasicAuthorizer _oldAuthorizer,
        RoleData[] memory _rolesData
    ) {
        // At creation, the migrator will be the root of the TimelockAuthorizer.
        // Once the migration is complete, the root permission will be transferred to `_root`.
        TimelockAuthorizer _newAuthorizer = new TimelockAuthorizer(address(this), _vault, CHANGE_ROOT_DELAY);
        newAuthorizer = _newAuthorizer;
        oldAuthorizer = _oldAuthorizer;
        root = _root;
        vault = _vault;

        for (uint256 i = 0; i < _rolesData.length; i++) {
            rolesData.push(RoleData(_rolesData[i].grantee, _rolesData[i].role, _rolesData[i].target));
        }

        // Enqueue a root change execution in the new authorizer to set it to the desired root address
        rootChangeExecutionId = _newAuthorizer.scheduleRootChange(_root, _arr(address(this)));
    }

    /**
     * @dev Tells whether the migration has been completed or not
     */
    function isComplete() public view returns (bool) {
        return migratedRoles >= rolesData.length;
    }

    /**
     * @dev Migrate roles from the old authorizer to the new one
     * @param n Number of roles to migrate, use 0 to migrate all the remaining ones
     */
    function migrate(uint256 n) external {
        require(!isComplete(), "MIGRATION_COMPLETE");
        _migrate(n == 0 ? rolesData.length : n);
        _afterMigrate();
    }

    /**
     * @dev Revoke migrator permissions and trigger change root action
     */
    function finalizeMigration() external {
        require(isComplete(), "MIGRATION_NOT_COMPLETE");
        // Safety check to avoid us migrating to a authorizer with an invalid root.
        // `root` must call `claimRoot` on `newAuthorizer` in order for us to set it on the Vault.
        require(newAuthorizer.isRoot(root), "ROOT_NOT_CLAIMED_YET");

        // Ensure the migrator contract has authority to change the vault's authorizer
        bytes32 setAuthorizerId = IAuthentication(address(vault)).getActionId(IVault.setAuthorizer.selector);
        bool canSetAuthorizer = oldAuthorizer.canPerform(setAuthorizerId, address(this), address(vault));
        require(canSetAuthorizer, "MIGRATOR_CANNOT_SET_AUTHORIZER");

        // Finally change the authorizer in the vault and trigger root change
        vault.setAuthorizer(newAuthorizer);
    }

    function _migrate(uint256 n) internal {
        uint256 i = migratedRoles;
        uint256 to = Math.min(i + n, rolesData.length);

        for (; i < to; i++) {
            RoleData memory roleData = rolesData[i];
            require(oldAuthorizer.canPerform(roleData.role, roleData.grantee, roleData.target), "UNEXPECTED_ROLE");
            newAuthorizer.grantPermissions(_arr(roleData.role), roleData.grantee, _arr(roleData.target));
        }

        migratedRoles = i;
    }

    function _afterMigrate() internal {
        // Execute only once after the migration ends
        if (!isComplete()) return;

        // Finally trigger the first step of transferring root ownership over the TimelockAuthorizer to `root`.
        // Before the migration can be finalized, `root` must call `claimRoot` on the `TimelockAuthorizer`.
        require(newAuthorizer.canExecute(rootChangeExecutionId), "CANNOT_TRIGGER_ROOT_CHANGE_YET");
        newAuthorizer.execute(rootChangeExecutionId);
    }

    function _arr(bytes32 a) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](1);
        arr[0] = a;
    }

    function _arr(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }
}
