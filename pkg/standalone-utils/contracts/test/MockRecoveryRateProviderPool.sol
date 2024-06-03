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

import "@balancer-labs/v2-interfaces/contracts/pool-utils/IRateProviderPool.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-pool-utils/contracts/BasePoolAuthorization.sol";
import "@balancer-labs/v2-pool-utils/contracts/RecoveryMode.sol";

contract MockRecoveryRateProviderPool is IRateProviderPool, BasePoolAuthorization, RecoveryMode {
    IVault private immutable _vault;
    bool private _recoveryMode;

    IRateProvider[] private _rateProviders;

    constructor(IVault vault, IRateProvider[] memory rateProviders)
        Authentication(bytes32(uint256(address(this))))
        BasePoolAuthorization(_DELEGATE_OWNER)
        RecoveryMode(vault)
    {
        _vault = vault;
        _rateProviders = rateProviders;
    }

    // IRateProviderPool

    function getRateProviders() external view override returns (IRateProvider[] memory) {
        return _rateProviders;
    }

    // BasePoolAuthorization

    function _getAuthorizer() internal view override returns (IAuthorizer) {
        return _vault.getAuthorizer();
    }

    // Recovery Mode

    function inRecoveryMode() public view override returns (bool) {
        return _recoveryMode;
    }

    function _setRecoveryMode(bool enabled) internal override {
        _recoveryMode = enabled;
    }

    function _doRecoveryModeExit(
        uint256[] memory,
        uint256,
        bytes memory
    ) internal override returns (uint256, uint256[] memory) {}
}
