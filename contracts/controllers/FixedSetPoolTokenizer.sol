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

import "hardhat/console.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../strategies/IAccSwapFeeStrategy.sol";

import "../vault/IVault.sol";
import "../math/FixedPoint.sol";

import "./BToken.sol";

contract FixedSetPoolTokenizer is BToken, ReentrancyGuard {
    using FixedPoint for uint128;
    using FixedPoint for uint256;
    using SafeCast for uint256;

    IVault public immutable vault;
    bytes32 public immutable poolId;
    address public immutable strategy;

    constructor(
        IVault _vault,
        address _strategy,
        IVault.StrategyType strategyType,
        uint256 initialBPT,
        IERC20[] memory tokens,
        uint128[] memory amounts,
        address from
    ) {
        bytes32 _poolId = _vault.newPool(_strategy, strategyType);
        _vault.addLiquidity(_poolId, from, tokens, amounts, false);

        _mintPoolShare(initialBPT);
        _pushPoolShare(from, initialBPT);

        // Set immutable state variables - these cannot be read from during construction
        vault = _vault;
        poolId = _poolId;
        strategy = _strategy;

        //Reset swap fees counter
        IAccSwapFeeStrategy(_strategy).resetAccSwapFees(amounts);
    }

    // Pays protocol swap fees
    function payProtocolFees() external {
        //Load tokens
        IERC20[] memory tokens = vault.getPoolTokens(poolId);
        //Load balances
        uint128[] memory balances = vault.getPoolTokenBalances(poolId, tokens);
        uint128[] memory swapFeesCollected = IAccSwapFeeStrategy(strategy).getAccSwapFees(balances);

        balances = vault.paySwapProtocolFees(poolId, tokens, swapFeesCollected);
        IAccSwapFeeStrategy(strategy).resetAccSwapFees(balances);
    }

    // Joining a pool
    // poolAmountOut - how much bpt the user expects to get
    // maxAmountsIn - the max amounts of each token the user is willing to add to the vault
    // The set of tokens is not specified because it is read from the Vault - and remains immutable that way.
    function joinPool(
        uint256 poolAmountOut,
        uint128[] calldata maxAmountsIn,
        bool transferTokens,
        address beneficiary
    ) external nonReentrant {
        //Load tokens
        IERC20[] memory tokens = vault.getPoolTokens(poolId);
        //Load balances
        uint128[] memory balances = vault.getPoolTokenBalances(poolId, tokens);

        //Pay protocol fees to have balances up to date
        uint128[] memory swapFeesCollected = IAccSwapFeeStrategy(strategy).getAccSwapFees(balances);
        balances = vault.paySwapProtocolFees(poolId, tokens, swapFeesCollected);

        uint256 poolTotal = totalSupply();
        uint128 ratio = poolAmountOut.div(poolTotal).toUint128();
        require(ratio != 0, "ERR_MATH_APPROX");

        require(maxAmountsIn.length == tokens.length, "Tokens and amounts length mismatch");

        uint128[] memory amountsIn = new uint128[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            amountsIn[i] = balances[i].mul128(ratio);
            require(amountsIn[i] <= maxAmountsIn[i], "ERR_LIMIT_IN");
        }

        vault.addLiquidity(poolId, msg.sender, tokens, amountsIn, !transferTokens);

        //Reset swap fees counter
        IAccSwapFeeStrategy(strategy).resetAccSwapFees(balances);

        _mintPoolShare(poolAmountOut);
        _pushPoolShare(beneficiary, poolAmountOut);
    }

    function exitPool(
        uint256 poolAmountIn,
        uint256[] calldata minAmountsOut,
        bool withdrawTokens,
        address beneficiary
    ) external nonReentrant {
        //Load tokens
        IERC20[] memory tokens = vault.getPoolTokens(poolId);
        //Load balances
        uint128[] memory balances = vault.getPoolTokenBalances(poolId, tokens);

        //Pay protocol fees to have balances up to date
        uint128[] memory swapFeesCollected = IAccSwapFeeStrategy(strategy).getAccSwapFees(balances);
        balances = vault.paySwapProtocolFees(poolId, tokens, swapFeesCollected);

        uint256 poolTotal = totalSupply();
        uint128 ratio = poolAmountIn.div(poolTotal).toUint128();
        require(ratio != 0, "ERR_MATH_APPROX");

        require(minAmountsOut.length == tokens.length, "Tokens and amounts length mismatch");

        uint128[] memory amountsOut = new uint128[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            amountsOut[i] = balances[i].mul128(ratio);
            require(amountsOut[i] >= minAmountsOut[i], "NOT EXITING ENOUGH");
        }

        vault.removeLiquidity(poolId, beneficiary, tokens, amountsOut, !withdrawTokens);

        //Reset swap fees counter
        IAccSwapFeeStrategy(strategy).resetAccSwapFees(balances);

        _pullPoolShare(msg.sender, poolAmountIn);
        _burnPoolShare(poolAmountIn);
    }

    function _pullPoolShare(address from, uint256 amount) internal {
        _pull(from, amount);
    }

    function _pushPoolShare(address to, uint256 amount) internal {
        _push(to, amount);
    }

    function _mintPoolShare(uint256 amount) internal {
        _mint(amount);
    }

    function _burnPoolShare(uint256 amount) internal {
        _burn(amount);
    }
}
