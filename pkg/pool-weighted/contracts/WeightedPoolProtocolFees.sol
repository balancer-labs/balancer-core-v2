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

import "@balancer-labs/v2-interfaces/contracts/pool-utils/IRateProvider.sol";
import "@balancer-labs/v2-pool-utils/contracts/ProtocolFeeCache.sol";
import "@balancer-labs/v2-pool-utils/contracts/InvariantGrowthProtocolSwapFees.sol";

import "./BaseWeightedPool.sol";

abstract contract WeightedPoolProtocolFees is BaseWeightedPool, ProtocolFeeCache {
    using FixedPoint for uint256;

    // Rate providers are used only for computing yield fees; they do not inform swap/join/exit.
    IRateProvider internal immutable _rateProvider0;
    IRateProvider internal immutable _rateProvider1;
    IRateProvider internal immutable _rateProvider2;
    IRateProvider internal immutable _rateProvider3;
    IRateProvider internal immutable _rateProvider4;
    IRateProvider internal immutable _rateProvider5;
    IRateProvider internal immutable _rateProvider6;
    IRateProvider internal immutable _rateProvider7;

    bool internal immutable _paysYieldFees;

    // All-time high value of the weighted product of the pool's token rates. Comparing such weighted products across
    // time provides a measure of the pool's growth resulting from rate changes. The pool also grows due to swap fees,
    // but that growth is captured in the invariant; rate growth is not.
    uint256 internal _athRateProduct;

    // This Pool pays protocol fees by measuring the growth of the invariant between joins and exits. Since weights are
    // immutable, the invariant only changes due to accumulated swap fees, which saves gas by freeing the Pool
    // from performing any computation or accounting associated with protocol fees during swaps.
    // This mechanism requires keeping track of the invariant after the last join or exit.
    uint256 private _lastPostJoinExitInvariant;

    constructor(uint256 numTokens, IRateProvider[] memory rateProviders) {
        _require(numTokens <= 8, Errors.MAX_TOKENS);
        InputHelpers.ensureInputLengthMatch(numTokens, rateProviders.length);

        // If we know that no rate providers are set then we can skip yield fees logic.
        // If so then set `_paysYieldFees` to false, otherwise set it to true.
        bool paysYieldFees = true;
        for (uint256 i = 0; i < numTokens; i++) {
            if (rateProviders[i] != IRateProvider(0)) break;
            paysYieldFees = false;
        }
        _paysYieldFees = paysYieldFees;

        _rateProvider0 = rateProviders[0];
        _rateProvider1 = rateProviders[1];
        _rateProvider2 = numTokens > 2 ? rateProviders[2] : IRateProvider(0);
        _rateProvider3 = numTokens > 3 ? rateProviders[3] : IRateProvider(0);
        _rateProvider4 = numTokens > 4 ? rateProviders[4] : IRateProvider(0);
        _rateProvider5 = numTokens > 5 ? rateProviders[5] : IRateProvider(0);
        _rateProvider6 = numTokens > 6 ? rateProviders[6] : IRateProvider(0);
        _rateProvider7 = numTokens > 7 ? rateProviders[7] : IRateProvider(0);
    }

    /**
     * @dev Returns the value of the invariant after the last join or exit operation.
     */
    function getLastInvariant() public view returns (uint256) {
        return _lastPostJoinExitInvariant;
    }

    function _getSwapProtocolFees(
        uint256[] memory preBalances,
        uint256[] memory normalizedWeights,
        uint256 preJoinExitSupply
    ) internal view returns (uint256) {
        uint256 protocolSwapFeePercentage = getProtocolFeePercentageCache(ProtocolFeeType.SWAP);

        // We return immediately if the fee percentage is zero to avoid unnecessary computation.
        if (protocolSwapFeePercentage == 0) return 0;

        // Before joins and exits, we measure the growth of the invariant compared to the invariant after the last join
        // or exit, which will have been caused by swap fees, and use it to mint BPT as protocol fees. This dilutes all
        // LPs, which means that new LPs will join the pool debt-free, and exiting LPs will pay any amounts due
        // before leaving.

        uint256 preJoinExitInvariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);

        // We pass `preJoinExitSupply` as the total supply twice as we're measuring over a period in which the total
        // supply has not changed.
        return
            InvariantGrowthProtocolSwapFees.calcDueProtocolFees(
                preJoinExitInvariant.divDown(_lastPostJoinExitInvariant),
                preJoinExitSupply,
                preJoinExitSupply,
                protocolSwapFeePercentage
            );
    }

    /**
     * @dev Returns the rate providers configured for each token (in the same order as registered).
     */
    function getRateProviders() external view returns (IRateProvider[] memory) {
        uint256 totalTokens = _getTotalTokens();
        IRateProvider[] memory providers = new IRateProvider[](totalTokens);

        // prettier-ignore
        {
            providers[0] = _rateProvider0;
            providers[1] = _rateProvider1;
            if (totalTokens > 2) { providers[2] = _rateProvider2; } else { return providers; }
            if (totalTokens > 3) { providers[3] = _rateProvider3; } else { return providers; }
            if (totalTokens > 4) { providers[4] = _rateProvider4; } else { return providers; }
            if (totalTokens > 5) { providers[5] = _rateProvider5; } else { return providers; }
            if (totalTokens > 6) { providers[6] = _rateProvider6; } else { return providers; }
            if (totalTokens > 7) { providers[7] = _rateProvider7; } else { return providers; }
        }

        return providers;
    }

    /**
     * @notice Returns the contribution to the total rate product from a token with the given weight and rate provider.
     */
    function _getRateFactor(uint256 normalizedWeight, IRateProvider provider) internal view returns (uint256) {
        return provider == IRateProvider(0) ? FixedPoint.ONE : provider.getRate().powDown(normalizedWeight);
    }

    /**
     * @dev Returns the weighted product of all the token rates.
     */
    function _getRateProduct(uint256[] memory normalizedWeights) internal view returns (uint256) {
        uint256 totalTokens = normalizedWeights.length;

        uint256 rateProduct = FixedPoint.mulDown(
            _getRateFactor(normalizedWeights[0], _rateProvider0),
            _getRateFactor(normalizedWeights[1], _rateProvider1)
        );

        if (totalTokens > 2) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[2], _rateProvider2));
        } else {
            return rateProduct;
        }
        if (totalTokens > 3) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[3], _rateProvider3));
        } else {
            return rateProduct;
        }
        if (totalTokens > 4) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[4], _rateProvider4));
        } else {
            return rateProduct;
        }
        if (totalTokens > 5) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[5], _rateProvider5));
        } else {
            return rateProduct;
        }
        if (totalTokens > 6) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[6], _rateProvider6));
        } else {
            return rateProduct;
        }
        if (totalTokens > 7) {
            rateProduct = rateProduct.mulDown(_getRateFactor(normalizedWeights[7], _rateProvider7));
        }

        return rateProduct;
    }

    function _getYieldProtocolFee(uint256[] memory normalizedWeights, uint256 preJoinExitSupply)
        internal
        returns (uint256)
    {
        if (!_paysYieldFees) return 0;

        uint256 athRateProduct = _athRateProduct;
        uint256 rateProduct = _getRateProduct(normalizedWeights);

        // Initialise `_athRateProduct`. This will occur on the first join/exit after Pool initialisation.
        // Not initialising this here properly will cause all joins/exits to revert.
        if (athRateProduct == 0) {
            _athRateProduct = rateProduct;
            return 0;
        }

        // Only charge yield fees if we've exceeded the all time high of Pool value generated through yield.
        // i.e. if the Pool makes a loss through the yield strategies then it shouldn't charge fees until it's
        // been recovered.
        if (rateProduct <= athRateProduct) return 0;

        // Yield manifests in the Pool by individual tokens becoming more valuable, we convert this into comparable
        // units by applying a rate to get the equivalent balance of non-yield-bearing tokens
        //
        // non-yield-bearing balance = rate * yield-bearing balance
        //                       x'i = ri * xi
        //
        // To measure the amount of fees to pay due to yield, we take advantage of the fact that scaling the
        // Pool's balances results in a scaling factor being applied to the original invariant.
        //
        // I(r1 * x1, r2 * x2) = (r1 * x1)^w1 * (r2 * x2)^w2
        //                     = (r1)^w1 * (r2)^w2 * (x1)^w1 * (x2)^w2
        //                     = I(r1, r2) * I(x1, x2)
        //
        // We then only need to measure the growth of this scaling factor to measure how the value of the BPT token
        // increases due to yield; we can ignore the invariant calculated from the Pool's balances as these cancel.
        // We then have the result:
        //
        // invariantGrowthRatio = I(r1_new, r2_new) / I(r1_old, r2_old)
        //
        // We then replace the stored value of I(r1_old, r2_old) with I(r1_new, r2_new) to ensure we only collect
        // fees on yield once.
        _athRateProduct = rateProduct;

        // We pass `preJoinExitSupply` as the total supply twice as we're measuring over a period in which the total
        // supply has not changed.
        return
            InvariantGrowthProtocolSwapFees.calcDueProtocolFees(
                rateProduct.divDown(athRateProduct),
                preJoinExitSupply,
                preJoinExitSupply,
                getProtocolFeePercentageCache(ProtocolFeeType.YIELD)
            );
    }

    function _getJoinExitProtocolFees(
        uint256[] memory preBalances,
        uint256[] memory balanceDeltas,
        uint256[] memory normalizedWeights,
        uint256 preJoinExitSupply,
        uint256 postJoinExitSupply
    ) internal view returns (uint256, uint256) {
        // We calculate `preJoinExitInvariant` now before we mutate `preBalances` into the post joinExit balances.
        uint256 preJoinExitInvariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);
        bool isJoin = postJoinExitSupply >= preJoinExitSupply;

        // Compute the post balances by adding or removing the deltas.
        for (uint256 i = 0; i < preBalances.length; ++i) {
            preBalances[i] = isJoin
                ? SafeMath.add(preBalances[i], balanceDeltas[i])
                : SafeMath.sub(preBalances[i], balanceDeltas[i]);
        }

        // preBalances have now been mutated to reflect the postJoinExit balances.
        uint256 postJoinExitInvariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);
        uint256 protocolSwapFeePercentage = getProtocolFeePercentageCache(ProtocolFeeType.SWAP);

        // We return immediately if the fee percentage is zero to avoid unnecessary computation.
        if (protocolSwapFeePercentage == 0) return (0, postJoinExitInvariant);

        uint256 protocolFeeAmount = InvariantGrowthProtocolSwapFees.calcDueProtocolFees(
            postJoinExitInvariant.divDown(preJoinExitInvariant),
            preJoinExitSupply,
            postJoinExitSupply,
            protocolSwapFeePercentage
        );

        return (protocolFeeAmount, postJoinExitInvariant);
    }

    function _updatePostJoinExit(uint256 postJoinExitInvariant) internal virtual override {
        // After all joins and exits we store the post join/exit invariant in order to compute growth due to swap fees
        // in the next one.
        _lastPostJoinExitInvariant = postJoinExitInvariant;
    }
}
