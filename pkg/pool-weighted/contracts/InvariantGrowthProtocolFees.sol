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

import "./BaseWeightedPool.sol";

abstract contract InvariantGrowthProtocolFees is BaseWeightedPool {
    using FixedPoint for uint256;

    // This Pool pays protocol fees by measuring the growth of the invariant between joins and exits. Since weights are
    // immutable, the invariant only changes due to accumulated swap fees, which saves gas by freeing the Pool
    // from performing any computation or accounting associated with protocol fees during swaps.
    // This mechanism requires keeping track of the invariant after the last join or exit.
    uint256 private _lastPostJoinExitInvariant;

    // All-time high value of the weighted product of the pool's token rates. Comparing such weighted products across
    // time provides a measure of the pool's growth resulting from rate changes. The pool also grows due to swap fees,
    // but that growth is captured in the invariant; rate growth is not.
    uint256 private _athRateProduct;

    // Rate providers are used only for computing yield fees; they do not inform swap/join/exit.
    IRateProvider internal immutable _rateProvider0;
    IRateProvider internal immutable _rateProvider1;
    IRateProvider internal immutable _rateProvider2;
    IRateProvider internal immutable _rateProvider3;
    IRateProvider internal immutable _rateProvider4;
    IRateProvider internal immutable _rateProvider5;
    IRateProvider internal immutable _rateProvider6;
    IRateProvider internal immutable _rateProvider7;
    IRateProvider internal immutable _rateProvider8;
    IRateProvider internal immutable _rateProvider9;
    IRateProvider internal immutable _rateProvider10;
    IRateProvider internal immutable _rateProvider11;
    IRateProvider internal immutable _rateProvider12;
    IRateProvider internal immutable _rateProvider13;
    IRateProvider internal immutable _rateProvider14;
    IRateProvider internal immutable _rateProvider15;
    IRateProvider internal immutable _rateProvider16;
    IRateProvider internal immutable _rateProvider17;
    IRateProvider internal immutable _rateProvider18;
    IRateProvider internal immutable _rateProvider19;

    constructor(IRateProvider[] memory rateProviders) {
        uint256 numTokens = rateProviders.length;

        _rateProvider0 = rateProviders[0];
        _rateProvider1 = rateProviders[1];
        _rateProvider2 = numTokens > 2 ? rateProviders[2] : IRateProvider(0);
        _rateProvider3 = numTokens > 3 ? rateProviders[3] : IRateProvider(0);
        _rateProvider4 = numTokens > 4 ? rateProviders[4] : IRateProvider(0);
        _rateProvider5 = numTokens > 5 ? rateProviders[5] : IRateProvider(0);
        _rateProvider6 = numTokens > 6 ? rateProviders[6] : IRateProvider(0);
        _rateProvider7 = numTokens > 7 ? rateProviders[7] : IRateProvider(0);
        _rateProvider8 = numTokens > 8 ? rateProviders[8] : IRateProvider(0);
        _rateProvider9 = numTokens > 9 ? rateProviders[9] : IRateProvider(0);
        _rateProvider10 = numTokens > 10 ? rateProviders[10] : IRateProvider(0);
        _rateProvider11 = numTokens > 11 ? rateProviders[11] : IRateProvider(0);
        _rateProvider12 = numTokens > 12 ? rateProviders[12] : IRateProvider(0);
        _rateProvider13 = numTokens > 13 ? rateProviders[13] : IRateProvider(0);
        _rateProvider14 = numTokens > 14 ? rateProviders[14] : IRateProvider(0);
        _rateProvider15 = numTokens > 15 ? rateProviders[15] : IRateProvider(0);
        _rateProvider16 = numTokens > 16 ? rateProviders[16] : IRateProvider(0);
        _rateProvider17 = numTokens > 17 ? rateProviders[17] : IRateProvider(0);
        _rateProvider18 = numTokens > 18 ? rateProviders[18] : IRateProvider(0);
        _rateProvider19 = numTokens > 19 ? rateProviders[19] : IRateProvider(0);

        // TODO: Initialize this here instead of checking inside each join/exit?
        _athRateProduct = 0;
    }

    /**
     * @dev Returns the value of the invariant after the last join or exit operation.
     */
    function getLastInvariant() public view returns (uint256) {
        return _lastPostJoinExitInvariant;
    }

    /**
     * @dev Returns the rate providers configured for each token (in the same order as registered).
     */
    function getRateProviders() external view returns (IRateProvider[] memory providers) {
        uint256 totalTokens = _getTotalTokens();
        providers = new IRateProvider[](totalTokens);

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
            if (totalTokens > 8) { providers[8] = _rateProvider8; } else { return providers; }
            if (totalTokens > 9) { providers[9] = _rateProvider9; } else { return providers; }
            if (totalTokens > 10) { providers[10] = _rateProvider10; } else { return providers; }
            if (totalTokens > 11) { providers[11] = _rateProvider11; } else { return providers; }
            if (totalTokens > 12) { providers[12] = _rateProvider12; } else { return providers; }
            if (totalTokens > 13) { providers[13] = _rateProvider13; } else { return providers; }
            if (totalTokens > 14) { providers[14] = _rateProvider14; } else { return providers; }
            if (totalTokens > 15) { providers[15] = _rateProvider15; } else { return providers; }
            if (totalTokens > 16) { providers[16] = _rateProvider16; } else { return providers; }
            if (totalTokens > 17) { providers[17] = _rateProvider17; } else { return providers; }
            if (totalTokens > 18) { providers[18] = _rateProvider18; } else { return providers; }
            if (totalTokens > 19) { providers[19] = _rateProvider19; } else { return providers; }
        }
    }

    /**
     * @dev Returns the rate from provider. All rates are fixed-point values with 18 decimals.
     * In case provider is the zero address, it returns FixedPoint.ONE.
     */
    function _getRate(IRateProvider provider) internal view returns (uint256) {
        return provider == IRateProvider(0) ? FixedPoint.ONE : provider.getRate();
    }

    /**
     * @dev Returns the rates for all tokens.
     */
    function _getRates() internal view returns (uint256[] memory rates) {
        uint256 totalTokens = _getTotalTokens();
        rates = new uint256[](totalTokens);

        // prettier-ignore
        {
            rates[0] = _getRate(_rateProvider0);
            rates[1] = _getRate(_rateProvider1);
            if (totalTokens > 2) { rates[2] = _getRate(_rateProvider2); } else { return rates; }
            if (totalTokens > 3) { rates[3] = _getRate(_rateProvider3); } else { return rates; }
            if (totalTokens > 4) { rates[4] = _getRate(_rateProvider4); } else { return rates; }
            if (totalTokens > 5) { rates[5] = _getRate(_rateProvider5); } else { return rates; }
            if (totalTokens > 6) { rates[6] = _getRate(_rateProvider6); } else { return rates; }
            if (totalTokens > 7) { rates[7] = _getRate(_rateProvider7); } else { return rates; }
            if (totalTokens > 8) { rates[8] = _getRate(_rateProvider8); } else { return rates; }
            if (totalTokens > 9) { rates[9] = _getRate(_rateProvider9); } else { return rates; }
            if (totalTokens > 10) { rates[10] = _getRate(_rateProvider10); } else { return rates; }
            if (totalTokens > 11) { rates[11] = _getRate(_rateProvider11); } else { return rates; }
            if (totalTokens > 12) { rates[12] = _getRate(_rateProvider12); } else { return rates; }
            if (totalTokens > 13) { rates[13] = _getRate(_rateProvider13); } else { return rates; }
            if (totalTokens > 14) { rates[14] = _getRate(_rateProvider14); } else { return rates; }
            if (totalTokens > 15) { rates[15] = _getRate(_rateProvider15); } else { return rates; }
            if (totalTokens > 16) { rates[16] = _getRate(_rateProvider16); } else { return rates; }
            if (totalTokens > 17) { rates[17] = _getRate(_rateProvider17); } else { return rates; }
            if (totalTokens > 18) { rates[18] = _getRate(_rateProvider18); } else { return rates; }
            if (totalTokens > 19) { rates[19] = _getRate(_rateProvider19); } else { return rates; }
        }
    }

    function _beforeJoinExit(
        uint256[] memory preBalances,
        uint256[] memory normalizedWeights,
        uint256 protocolSwapFeePercentage
    ) internal virtual override {
        // Before joins and exits, we measure the growth of the invariant compared to the invariant after the last join
        // or exit, which will have been caused by swap fees, and use it to mint BPT as protocol fees. This dilutes all
        // LPs, which means that new LPs will join the pool debt-free, and exiting LPs will pay any amounts due
        // before leaving.

        // We return immediately if the fee percentage is zero (to avoid unnecessary computation), or when the pool is
        // paused (to avoid complex computation during emergency withdrawals).
        if ((protocolSwapFeePercentage == 0) || !_isNotPaused()) {
            return;
        }

        uint256 preJoinExitInvariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);

        uint256 supply = totalSupply();
        uint256 swapFees = WeightedMath._calcDueProtocolSwapFeeBptAmount(
            supply,
            _lastPostJoinExitInvariant,
            preJoinExitInvariant,
            protocolSwapFeePercentage
        );

        uint256 yieldFees = 0;
        uint256 athRateProduct = _athRateProduct;
        if (athRateProduct == 0) {
            // Initialize the all-time high rate product. This will occur during the INIT join just after pool
            // creation. This variable is used for comparison across time, so it must be initialized properly to avoid
            // overpaying protocol fees.
            _athRateProduct = WeightedMath._calculateWeightedProduct(normalizedWeights, _getRates());
        } else {
            uint256 rateProduct = WeightedMath._calculateWeightedProduct(normalizedWeights, _getRates());

            // Only collect protocol fees when yield growth exceeds previous all-time high.
            if (rateProduct > athRateProduct) {
                yieldFees = WeightedMath._calcDueProtocolSwapFeeBptAmount(
                    supply.add(swapFees),
                    athRateProduct,
                    rateProduct,
                    // TODO: This fee pct should come from a different source.
                    protocolSwapFeePercentage
                );

                _athRateProduct = rateProduct;
            }
        }

        _payProtocolFees(swapFees.add(yieldFees));
    }

    function _afterJoinExit(
        bool isJoin,
        uint256[] memory preBalances,
        uint256[] memory balanceDeltas,
        uint256[] memory normalizedWeights
    ) internal virtual override {
        // After all joins and exits we store the post join/exit invariant in order to compute growth due to swap fees
        // in the next one.

        // Compute the post balances by adding or removing the deltas. Note that we're allowed to mutate preBalances.
        for (uint256 i = 0; i < preBalances.length; ++i) {
            // Cannot optimize calls with a function selector: there are 2- and 3-argument versions of SafeMath.sub
            preBalances[i] = isJoin
                ? SafeMath.add(preBalances[i], balanceDeltas[i])
                : SafeMath.sub(preBalances[i], balanceDeltas[i]);
        }

        uint256 postJoinExitInvariant = WeightedMath._calculateInvariant(normalizedWeights, preBalances);
        _lastPostJoinExitInvariant = postJoinExitInvariant;
    }
}
