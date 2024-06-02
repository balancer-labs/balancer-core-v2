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

pragma solidity >=0.7.0 <0.9.0;

import "../solidity-utils/openzeppelin/IERC20.sol";

interface IComposableStablePoolRates {
    /**
     * @dev Forces a rate cache hit for a token.
     * It will revert if the requested token does not have an associated rate provider.
     *
     * This function will revert when called within a Vault context (i.e. in the middle of a join or an exit).
     *
     * This function depends on `getRate` via the rate provider, which may be calculated incorrectly in the middle of a
     * join or an exit because the state of the pool could be out of sync with the state of the Vault. It is protected
     * by a call to `VaultReentrancyLib.ensureNotInVaultContext` where overridden in `ComposableStablePoolRates`, and so
     * is safe to call on ComposableStablePool.
     * See https://forum.balancer.fi/t/reentrancy-vulnerability-scope-expanded/4345 for reference.
     *
     * It will also revert if there was no rate provider set initially.
     *
     * @param token The token whose rate cache will be updated.
     */
    function updateTokenRateCache(IERC20 token) external;

    /**
     * @dev Sets a new duration for a token rate cache.
     * Note this function also updates the current cached value.
     *
     * This function will revert when called within a Vault context (i.e. in the middle of a join or an exit).
     *
     * This function depends on `getRate` via the rate provider, which may be calculated incorrectly in the middle of a
     * join or an exit because the state of the pool could be out of sync with the state of the Vault. It is protected
     * by a call to `VaultReentrancyLib.ensureNotInVaultContext` where overridden in `ComposableStablePoolRates`, and so
     * is safe to call on ComposableStablePool.
     * See https://forum.balancer.fi/t/reentrancy-vulnerability-scope-expanded/4345 for reference.
     *
     * It will also revert if there was no rate provider set initially.
     *
     * @param duration Number of seconds until the current token rate is fetched again.
     */
    function setTokenRateCacheDuration(IERC20 token, uint256 duration) external;
}
