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

import "hardhat/console.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../BToken.sol";
import "../IBPTPool.sol";

import "../../vault/IVault.sol";
import "../../vault/interfaces/ITupleTradingStrategy.sol";
import "../../math/FixedPoint.sol";

import "./StablecoinMath.sol";

contract StablecoinPool is ITupleTradingStrategy, IBPTPool, StablecoinMath, BToken, ReentrancyGuard {
    using FixedPoint for uint128;
    using FixedPoint for uint256;
    using SafeCast for uint256;

    IVault private immutable _vault;
    bytes32 private immutable _poolId;

    uint128 private immutable _amp;
    uint128 private immutable _swapFee;

    uint128 private constant _MIN_SWAP_FEE = 0;
    uint128 private constant _MAX_SWAP_FEE = 10 * (10**16); // 10%

    constructor(
        IVault vault,
        uint256 initialBPT,
        IERC20[] memory tokens,
        uint128[] memory amounts,
        address from,
        uint128 amp,
        uint128 swapFee
    ) {
        require(tokens.length >= 2, "ERR_MIN_TOKENS");

        bytes32 poolId = vault.newPool(address(this), IVault.StrategyType.TUPLE);

        vault.addLiquidity(poolId, from, tokens, amounts, false);

        require(vault.getPoolTokens(poolId).length == tokens.length, "ERR_REPEATED_TOKENS");

        _mintPoolShare(initialBPT);
        _pushPoolShare(from, initialBPT);

        // Set immutable state variables - these cannot be read from during construction
        _vault = vault;
        _poolId = poolId;

        require(swapFee >= _MIN_SWAP_FEE, "ERR__MIN_SWAP_FEE");
        require(swapFee <= _MAX_SWAP_FEE, "ERR_MAX_MAX_FEE");
        _swapFee = swapFee;

        _amp = amp;
    }

    //Getters

    function getVault() external view override returns (IVault) {
        return _vault;
    }

    function getPoolId() external view override returns (bytes32) {
        return _poolId;
    }

    function getAmplification() external view returns (uint128) {
        return _amp;
    }

    function getSwapFee() external view returns (uint128) {
        return _swapFee;
    }

    //Quote Swaps

    function quoteOutGivenIn(
        QuoteRequestGivenIn calldata request,
        uint128[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) external view override returns (uint128) {
        uint128 adjustedIn = _subtractSwapFee(request.amountIn);
        uint128 maximumAmountOut = _outGivenIn(_amp, balances, indexIn, indexOut, adjustedIn);
        return maximumAmountOut;
    }

    function quoteInGivenOut(
        QuoteRequestGivenOut calldata request,
        uint128[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) external view override returns (uint128) {
        uint128 minimumAmountIn = _inGivenOut(_amp, balances, indexIn, indexOut, request.amountOut);
        return _addSwapFee(minimumAmountIn);
    }

    //Protocol Fees

    function _getAccSwapFees(uint128[] memory balances) internal pure returns (uint128[] memory) {
        uint128[] memory swapFeesCollected = new uint128[](balances.length);
        //TODO: calculate swap fee and pick random token
        return swapFeesCollected;
    }

    function _resetAccSwapFees(uint128[] memory balances) internal {
        // solhint-disable-previous-line no-empty-blocks
        //TODO: reset swap fees
    }

    // Pays protocol swap fees
    function payProtocolFees() external {
        //Load tokens
        IERC20[] memory tokens = _vault.getPoolTokens(_poolId);
        //Load balances
        uint128[] memory balances = _vault.getPoolTokenBalances(_poolId, tokens);
        uint128[] memory swapFeesCollected = _getAccSwapFees(balances);

        balances = _vault.paySwapProtocolFees(_poolId, tokens, swapFeesCollected);
        _resetAccSwapFees(balances);
    }

    //Join / Exit

    function joinPool(
        uint256 poolAmountOut,
        uint128[] calldata maxAmountsIn,
        bool transferTokens,
        address beneficiary
    ) external override nonReentrant {
        IERC20[] memory tokens = _vault.getPoolTokens(_poolId);
        uint128[] memory balances = _vault.getPoolTokenBalances(_poolId, tokens);

        //Pay protocol fees to have balances up to date
        uint128[] memory swapFeesCollected = _getAccSwapFees(balances);
        balances = _vault.paySwapProtocolFees(_poolId, tokens, swapFeesCollected);

        uint256 poolTotal = totalSupply();
        uint128 ratio = poolAmountOut.div(poolTotal).toUint128();
        require(ratio != 0, "ERR_MATH_APPROX");

        require(maxAmountsIn.length == tokens.length, "Tokens and amounts length mismatch");

        uint128[] memory amountsIn = new uint128[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            amountsIn[i] = balances[i].mul128(ratio);
            require(amountsIn[i] <= maxAmountsIn[i], "ERR_LIMIT_IN");
        }

        _vault.addLiquidity(_poolId, msg.sender, tokens, amountsIn, !transferTokens);

        //Reset swap fees counter
        _resetAccSwapFees(balances);

        _mintPoolShare(poolAmountOut);
        _pushPoolShare(beneficiary, poolAmountOut);
    }

    function exitPool(
        uint256 poolAmountIn,
        uint256[] calldata minAmountsOut,
        bool withdrawTokens,
        address beneficiary
    ) external override nonReentrant {
        IERC20[] memory tokens = _vault.getPoolTokens(_poolId);
        uint128[] memory balances = _vault.getPoolTokenBalances(_poolId, tokens);

        //Pay protocol fees to have balances up to date
        uint128[] memory swapFeesCollected = _getAccSwapFees(balances);
        balances = _vault.paySwapProtocolFees(_poolId, tokens, swapFeesCollected);

        uint256 poolTotal = totalSupply();
        uint128 ratio = poolAmountIn.div(poolTotal).toUint128();
        require(ratio != 0, "ERR_MATH_APPROX");

        require(minAmountsOut.length == tokens.length, "Tokens and amounts length mismatch");

        uint128[] memory amountsOut = new uint128[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            amountsOut[i] = balances[i].mul128(ratio);
            require(amountsOut[i] >= minAmountsOut[i], "NOT EXITING ENOUGH");
        }

        _vault.removeLiquidity(_poolId, beneficiary, tokens, amountsOut, !withdrawTokens);

        //Reset swap fees counter
        _resetAccSwapFees(balances);

        _pullPoolShare(msg.sender, poolAmountIn);
        _burnPoolShare(poolAmountIn);
    }

    // potential helpers
    function _addSwapFee(uint128 amount) internal view returns (uint128) {
        return amount.div128(FixedPoint.ONE.sub128(_swapFee));
    }

    function _subtractSwapFee(uint128 amount) internal view returns (uint128) {
        uint128 fees = amount.mul128(_swapFee);
        return amount.sub128(fees);
    }

    // Move to BalancerPoolToken (BToken)

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
