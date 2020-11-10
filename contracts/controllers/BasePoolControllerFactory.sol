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

pragma solidity ^0.7.1;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import "../vault/IVault.sol";

abstract contract BasePoolControllerFactory {
    using Address for address;

    IVault public immutable vault;

    event ControllerCreated(address indexed controller);

    constructor(IVault _vault) {
        vault = _vault;
    }

    /**
     * @dev Deploys a controller contract defined by `creationCode`. The `salt` value is only used in determining the
     * resulting controller address. Any value can be passed, but reusing `salt` for a given `creationCode` results in
     * a revert.
     *
     * Before the constructor of the created contract is executed, the factory will register it in the Vault as a
     * Trusted Operator. This means the contract will be able to pull funds from both User Balance and tokens that have
     * been granted allowance. As is always the case when dealing with Trusted Operators, the contract should be careful
     * to authenticate any addresses they use this way.
     *
     * The creation code for a Solidity contract can be constructed by concatenating the `creationCode` property of the
     * contract type with the ABI-encoded constructor arguments. Note that the compiler doesn't perform any type
     * checking here: all factory-created contracts should be subject to at least basic testing.
     *
     * Sample usage using abi.encodePacked to concatenate the `bytes` arrays:
     *   _create(abi.encodePacked(type(ERC20).creationCode, abi.encode("My Token", "TKN", 18)), salt);
     *
     * Emits a `ControllerCreated` event.
     *
     * Returns the address of the created contract.
     */
    function _create(bytes memory creationCode, bytes32 salt) internal returns (address) {
        address expectedController = Create2.computeAddress(salt, keccak256(creationCode));
        require(!expectedController.isContract(), "Salt cannot be reused");

        vault.reportTrustedOperator(expectedController);

        address controller = Create2.deploy(0, salt, creationCode);
        assert(controller == expectedController);

        emit ControllerCreated(controller);

        return controller;
    }
}
