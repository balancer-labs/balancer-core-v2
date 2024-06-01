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

import "./BaseWeightedPool.sol";
import "./WeightedPoolProtocolFees.sol";
import "./CustomFeeAuthorizer.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract WeightedPool is BaseWeightedPool, WeightedPoolProtocolFees, CustomFeeAuthorizer {
    using FixedPoint for uint256;
    using WeightedPoolUserData for bytes;

    uint256 private constant _MAX_TOKENS = 8;

    uint256 private immutable _totalTokens;

    IERC20 internal immutable _token0;
    IERC20 internal immutable _token1;
    IERC20 internal immutable _token2;
    IERC20 internal immutable _token3;
    IERC20 internal immutable _token4;
    IERC20 internal immutable _token5;
    IERC20 internal immutable _token6;
    IERC20 internal immutable _token7;

    // All token balances are normalized to behave as if the token had 18 decimals. We assume a token's decimals will
    // not change throughout its lifetime, and store the corresponding scaling factor for each at construction time.
    // These factors are always greater than or equal to one: tokens with more than 18 decimals are not supported.

    uint256 internal immutable _scalingFactor0;
    uint256 internal immutable _scalingFactor1;
    uint256 internal immutable _scalingFactor2;
    uint256 internal immutable _scalingFactor3;
    uint256 internal immutable _scalingFactor4;
    uint256 internal immutable _scalingFactor5;
    uint256 internal immutable _scalingFactor6;
    uint256 internal immutable _scalingFactor7;

    uint256 internal immutable _normalizedWeight0;
    uint256 internal immutable _normalizedWeight1;
    uint256 internal immutable _normalizedWeight2;
    uint256 internal immutable _normalizedWeight3;
    uint256 internal immutable _normalizedWeight4;
    uint256 internal immutable _normalizedWeight5;
    uint256 internal immutable _normalizedWeight6;
    uint256 internal immutable _normalizedWeight7;

    struct NewPoolParams {
        string name;
        string symbol;
        IERC20[] tokens;
        uint256[] normalizedWeights;
        IRateProvider[] rateProviders;
        address[] assetManagers;
        uint256 swapFeePercentage;
        bool isCustomFeeEnabled;
    }

    constructor(
        NewPoolParams memory params,
        IVault vault,
        IProtocolFeePercentagesProvider protocolFeeProvider,
        uint256 pauseWindowDuration,
        uint256 bufferPeriodDuration,
        address owner
    )
        BaseWeightedPool(
            vault,
            params.name,
            params.symbol,
            params.tokens,
            params.assetManagers,
            params.swapFeePercentage,
            pauseWindowDuration,
            bufferPeriodDuration,
            owner,
            false
        )
        ProtocolFeeCache(
            protocolFeeProvider,
            ProviderFeeIDs({ swap: ProtocolFeeType.SWAP, yield: ProtocolFeeType.YIELD, aum: ProtocolFeeType.AUM })
        )
        WeightedPoolProtocolFees(params.tokens.length, params.rateProviders)
        CustomFeeAuthorizer(params.isCustomFeeEnabled)
    {
        uint256 numTokens = params.tokens.length;
        InputHelpers.ensureInputLengthMatch(numTokens, params.normalizedWeights.length);

        _totalTokens = numTokens;

        // Ensure each normalized weight is above the minimum
        uint256 normalizedSum = 0;
        for (uint8 i = 0; i < numTokens; i++) {
            uint256 normalizedWeight = params.normalizedWeights[i];

            _require(normalizedWeight >= WeightedMath._MIN_WEIGHT, Errors.MIN_WEIGHT);
            normalizedSum = normalizedSum.add(normalizedWeight);
        }
        // Ensure that the normalized weights sum to ONE
        _require(normalizedSum == FixedPoint.ONE, Errors.NORMALIZED_WEIGHT_INVARIANT);

        // Immutable variables cannot be initialized inside an if statement, so we must do conditional assignments
        _token0 = params.tokens[0];
        _token1 = params.tokens[1];
        _token2 = numTokens > 2 ? params.tokens[2] : IERC20(0);
        _token3 = numTokens > 3 ? params.tokens[3] : IERC20(0);
        _token4 = numTokens > 4 ? params.tokens[4] : IERC20(0);
        _token5 = numTokens > 5 ? params.tokens[5] : IERC20(0);
        _token6 = numTokens > 6 ? params.tokens[6] : IERC20(0);
        _token7 = numTokens > 7 ? params.tokens[7] : IERC20(0);

        _scalingFactor0 = _computeScalingFactor(params.tokens[0]);
        _scalingFactor1 = _computeScalingFactor(params.tokens[1]);
        _scalingFactor2 = numTokens > 2 ? _computeScalingFactor(params.tokens[2]) : 0;
        _scalingFactor3 = numTokens > 3 ? _computeScalingFactor(params.tokens[3]) : 0;
        _scalingFactor4 = numTokens > 4 ? _computeScalingFactor(params.tokens[4]) : 0;
        _scalingFactor5 = numTokens > 5 ? _computeScalingFactor(params.tokens[5]) : 0;
        _scalingFactor6 = numTokens > 6 ? _computeScalingFactor(params.tokens[6]) : 0;
        _scalingFactor7 = numTokens > 7 ? _computeScalingFactor(params.tokens[7]) : 0;

        _normalizedWeight0 = params.normalizedWeights[0];
        _normalizedWeight1 = params.normalizedWeights[1];
        _normalizedWeight2 = numTokens > 2 ? params.normalizedWeights[2] : 0;
        _normalizedWeight3 = numTokens > 3 ? params.normalizedWeights[3] : 0;
        _normalizedWeight4 = numTokens > 4 ? params.normalizedWeights[4] : 0;
        _normalizedWeight5 = numTokens > 5 ? params.normalizedWeights[5] : 0;
        _normalizedWeight6 = numTokens > 6 ? params.normalizedWeights[6] : 0;
        _normalizedWeight7 = numTokens > 7 ? params.normalizedWeights[7] : 0;
    }

    function _getNormalizedWeight(IERC20 token) internal view virtual override returns (uint256) {
        // prettier-ignore
        if (token == _token0) { return _normalizedWeight0; }
        else if (token == _token1) { return _normalizedWeight1; }
        else if (token == _token2) { return _normalizedWeight2; }
        else if (token == _token3) { return _normalizedWeight3; }
        else if (token == _token4) { return _normalizedWeight4; }
        else if (token == _token5) { return _normalizedWeight5; }
        else if (token == _token6) { return _normalizedWeight6; }
        else if (token == _token7) { return _normalizedWeight7; }
        else {
            _revert(Errors.INVALID_TOKEN);
        }
    }

    function _getNormalizedWeights() internal view virtual override returns (uint256[] memory) {
        uint256 totalTokens = _getTotalTokens();
        uint256[] memory normalizedWeights = new uint256[](totalTokens);

        // prettier-ignore
        {
            normalizedWeights[0] = _normalizedWeight0;
            normalizedWeights[1] = _normalizedWeight1;
            if (totalTokens > 2) { normalizedWeights[2] = _normalizedWeight2; } else { return normalizedWeights; }
            if (totalTokens > 3) { normalizedWeights[3] = _normalizedWeight3; } else { return normalizedWeights; }
            if (totalTokens > 4) { normalizedWeights[4] = _normalizedWeight4; } else { return normalizedWeights; }
            if (totalTokens > 5) { normalizedWeights[5] = _normalizedWeight5; } else { return normalizedWeights; }
            if (totalTokens > 6) { normalizedWeights[6] = _normalizedWeight6; } else { return normalizedWeights; }
            if (totalTokens > 7) { normalizedWeights[7] = _normalizedWeight7; } else { return normalizedWeights; }
        }

        return normalizedWeights;
    }

    function _getMaxTokens() internal pure virtual override returns (uint256) {
        return _MAX_TOKENS;
    }

    function _getTotalTokens() internal view virtual override returns (uint256) {
        return _totalTokens;
    }

    /**
     * @dev Returns the scaling factor for one of the Pool's tokens. Reverts if `token` is not a token registered by the
     * Pool.
     */
    function _scalingFactor(IERC20 token) internal view virtual override returns (uint256) {
        // prettier-ignore
        if (token == _token0) { return _getScalingFactor0(); }
        else if (token == _token1) { return _getScalingFactor1(); }
        else if (token == _token2) { return _getScalingFactor2(); }
        else if (token == _token3) { return _getScalingFactor3(); }
        else if (token == _token4) { return _getScalingFactor4(); }
        else if (token == _token5) { return _getScalingFactor5(); }
        else if (token == _token6) { return _getScalingFactor6(); }
        else if (token == _token7) { return _getScalingFactor7(); }
        else {
            _revert(Errors.INVALID_TOKEN);
        }
    }

    function _scalingFactors() internal view virtual override returns (uint256[] memory) {
        uint256 totalTokens = _getTotalTokens();
        uint256[] memory scalingFactors = new uint256[](totalTokens);

        // prettier-ignore
        {
            scalingFactors[0] = _getScalingFactor0();
            scalingFactors[1] = _getScalingFactor1();
            if (totalTokens > 2) { scalingFactors[2] = _getScalingFactor2(); } else { return scalingFactors; }
            if (totalTokens > 3) { scalingFactors[3] = _getScalingFactor3(); } else { return scalingFactors; }
            if (totalTokens > 4) { scalingFactors[4] = _getScalingFactor4(); } else { return scalingFactors; }
            if (totalTokens > 5) { scalingFactors[5] = _getScalingFactor5(); } else { return scalingFactors; }
            if (totalTokens > 6) { scalingFactors[6] = _getScalingFactor6(); } else { return scalingFactors; }
            if (totalTokens > 7) { scalingFactors[7] = _getScalingFactor7(); } else { return scalingFactors; }
        }

        return scalingFactors;
    }

    // Initialize

    function _onInitializePool(
        bytes32 poolId,
        address sender,
        address recipient,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal virtual override returns (uint256, uint256[] memory) {
        // Initialize `_athRateProduct` if the Pool will pay protocol fees on yield.
        // Not initializing this here properly will cause all joins/exits to revert.
        if (!_isExemptFromYieldProtocolFees()) _updateATHRateProduct(_getRateProduct(_getNormalizedWeights()));

        return super._onInitializePool(poolId, sender, recipient, scalingFactors, userData);
    }

    // WeightedPoolProtocolFees functions

    function _beforeJoinExit(uint256[] memory preBalances, uint256[] memory normalizedWeights)
        internal
        virtual
        override
        returns (uint256, uint256)
    {
        uint256 supplyBeforeFeeCollection = totalSupply();
        uint256 invariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);
        (uint256 protocolFeesToBeMinted, uint256 athRateProduct) = _getPreJoinExitProtocolFees(
            invariant,
            normalizedWeights,
            supplyBeforeFeeCollection
        );

        // We then update the recorded value of `athRateProduct` to ensure we only collect fees on yield once.
        // A zero value for `athRateProduct` represents that it is unchanged so we can skip updating it.
        if (athRateProduct > 0) {
            _updateATHRateProduct(athRateProduct);
        }

        _payProtocolFees(protocolFeesToBeMinted);

        return (supplyBeforeFeeCollection.add(protocolFeesToBeMinted), invariant);
    }

    function _afterJoinExit(
        uint256 preJoinExitInvariant,
        uint256[] memory preBalances,
        uint256[] memory balanceDeltas,
        uint256[] memory normalizedWeights,
        uint256 preJoinExitSupply,
        uint256 postJoinExitSupply
    ) internal virtual override {
        uint256 protocolFeesToBeMinted = _getPostJoinExitProtocolFees(
            preJoinExitInvariant,
            preBalances,
            balanceDeltas,
            normalizedWeights,
            preJoinExitSupply,
            postJoinExitSupply
        );

        _payProtocolFees(protocolFeesToBeMinted);
    }

    function _updatePostJoinExit(uint256 postJoinExitInvariant)
        internal
        virtual
        override(BaseWeightedPool, WeightedPoolProtocolFees)
    {
        WeightedPoolProtocolFees._updatePostJoinExit(postJoinExitInvariant);
    }

    function _beforeProtocolFeeCacheUpdate() internal override {
        // The `getRate()` function depends on the actual supply, which in turn depends on the cached protocol fee
        // percentages. Changing these would therefore result in the rate changing, which is not acceptable as this is a
        // sensitive value.
        // Because of this, we pay any due protocol fees *before* updating the cache, making it so that the new
        // percentages only affect future operation of the Pool, and not past fees. As a result, `getRate()` is
        // unaffected by the cached protocol fee percentages changing.

        // Given that this operation is state-changing and relatively complex, we only allow it as long as the Pool is
        // not paused.
        _ensureNotPaused();

        uint256 invariant = getInvariant();

        (uint256 protocolFeesToBeMinted, uint256 athRateProduct) = _getPreJoinExitProtocolFees(
            invariant,
            _getNormalizedWeights(),
            totalSupply()
        );

        _payProtocolFees(protocolFeesToBeMinted);

        // With the fees paid, we now store the current invariant and update the ATH rate product (if necessary),
        // marking the Pool as free of protocol debt.

        _updatePostJoinExit(invariant);
        if (athRateProduct > 0) {
            _updateATHRateProduct(athRateProduct);
        }
    }

    /**
     * @notice Returns the effective BPT supply.
     *
     * @dev This would be the same as `totalSupply` however the Pool owes debt to the Protocol in the form of unminted
     * BPT, which will be minted immediately before the next join or exit. We need to take these into account since,
     * even if they don't yet exist, they will effectively be included in any Pool operation that involves BPT.
     *
     * In the vast majority of cases, this function should be used instead of `totalSupply()`.
     */
    function getActualSupply() public view returns (uint256) {
        uint256 supply = totalSupply();

        (uint256 protocolFeesToBeMinted, ) = _getPreJoinExitProtocolFees(
            getInvariant(),
            _getNormalizedWeights(),
            supply
        );

        return supply.add(protocolFeesToBeMinted);
    }

    function _onDisableRecoveryMode() internal override {
        // Update the postJoinExitInvariant to the value of the currentInvariant, zeroing out any protocol swap fees.
        _updatePostJoinExit(getInvariant());

        // If the Pool has any protocol yield fees accrued then we update the athRateProduct to zero these out.
        // If the current rate product is less than the athRateProduct then we do not perform this update.
        // This prevents the Pool from paying protocol fees on the same yield twice if the rate product were to drop.
        if (!_isExemptFromYieldProtocolFees()) {
            uint256 athRateProduct = getATHRateProduct();
            uint256 rateProduct = _getRateProduct(_getNormalizedWeights());

            if (rateProduct > athRateProduct) {
                _updateATHRateProduct(rateProduct);
            }
        }
    }

    function _getScalingFactor0() internal view returns (uint256) {
        return _scalingFactor0;
    }

    function _getScalingFactor1() internal view returns (uint256) {
        return _scalingFactor1;
    }

    function _getScalingFactor2() internal view returns (uint256) {
        return _scalingFactor2;
    }

    function _getScalingFactor3() internal view returns (uint256) {
        return _scalingFactor3;
    }

    function _getScalingFactor4() internal view returns (uint256) {
        return _scalingFactor4;
    }

    function _getScalingFactor5() internal view returns (uint256) {
        return _scalingFactor5;
    }

    function _getScalingFactor6() internal view returns (uint256) {
        return _scalingFactor6;
    }

    function _getScalingFactor7() internal view returns (uint256) {
        return _scalingFactor7;
    }

    function _isOwnerOnlyAction(bytes32 actionId)
        internal
        view
        virtual
        override(BasePool, WeightedPoolProtocolFees)
        returns (bool)
    {
        return super._isOwnerOnlyAction(actionId);
    }

    function getSwapFeePercentage(bytes memory userData, OperationType operation)
        public
        view
        virtual
        override
        returns (uint256 fee)
    {
        // using tx.origin insted of msg.sender as these functions are called
        // during join/exit/swap via vault
        // solhint-disable-next-line avoid-tx-origin
        if (isCustomFeeEnabled() && canSetCustomFee(tx.origin)) {
            if (operation == OperationType.JOIN) {
                WeightedPoolUserData.JoinKind kind = userData.joinKind();
                if (kind == WeightedPoolUserData.JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT) {
                    fee = userData.exactTokensInForBptOutCustomFee();
                } else {
                    if (kind == WeightedPoolUserData.JoinKind.TOKEN_IN_FOR_EXACT_BPT_OUT) {
                        fee = userData.tokenInForExactBptOutCustomFee();
                    }
                }
            } else if (operation == OperationType.EXIT) {
                WeightedPoolUserData.ExitKind kind = userData.exitKind();
                if (kind == WeightedPoolUserData.ExitKind.EXACT_BPT_IN_FOR_ONE_TOKEN_OUT) {
                    fee = userData.exactBptInForTokenOutCustomFee();
                } else {
                    if (kind == WeightedPoolUserData.ExitKind.BPT_IN_FOR_EXACT_TOKENS_OUT) {
                        fee = userData.bptInForExactTokensOutCustomFee();
                    }
                }
            } else if (operation == OperationType.SWAP) {
                fee = userData.swapCustomFee();
            } else {
                _revert(Errors.INVALID_OPERATION_TYPE);
            }
        } else {
            fee = getSwapFeePercentage();
        }
    }

    function setSwapFeePercentage(uint256 swapFeePercentage) public virtual override whenNotPaused {
        // here msg.sender is used, as this function can be called directly by the admin
        // not via any other contract
        if (isCustomFeeEnabled()) {
            require(solver == msg.sender, "CALLER_IS_NOT_SOLVER");
            _setSwapFeePercentage(swapFeePercentage);
        } else {
            super.setSwapFeePercentage(swapFeePercentage);
        }
    }
    // used if else so that it should not break the existing flow
}
