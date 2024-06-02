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

import "@balancer-labs/v2-interfaces/contracts/pool-stable/StablePoolUserData.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/helpers/BalancerErrors.sol";
import "@balancer-labs/v2-interfaces/contracts/standalone-utils/IProtocolFeePercentagesProvider.sol";
import "@balancer-labs/v2-interfaces/contracts/pool-utils/IRateProvider.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/helpers/IVersion.sol";

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "@balancer-labs/v2-solidity-utils/contracts/helpers/ERC20Helpers.sol";
import "@balancer-labs/v2-solidity-utils/contracts/helpers/InputHelpers.sol";

import "@balancer-labs/v2-pool-utils/contracts/BaseGeneralPool.sol";
import "@balancer-labs/v2-pool-utils/contracts/lib/BasePoolMath.sol";
import "@balancer-labs/v2-pool-utils/contracts/rates/PriceRateCache.sol";

import "./ComposableStablePoolStorage.sol";
import "./ComposableStablePoolRates.sol";
import "./ComposableStablePoolStorage.sol";
import "./ComposableStablePoolRates.sol";
import "./ComposableStablePoolProtocolFees.sol";
import "./StablePoolAmplification.sol";
import "./StableMath.sol";

/**
 * @dev StablePool with preminted BPT and rate providers for each token, allowing for e.g. wrapped tokens with a known
 * price ratio, such as Compound's cTokens.
 *
 * BPT is preminted on Pool initialization and registered as one of the Pool's tokens, allowing for swaps to behave as
 * single-token joins or exits (by swapping a token for BPT). We also support regular joins and exits, which can mint
 * and burn BPT.
 *
 * Preminted BPT is deposited in the Vault as the initial balance of the Pool, and doesn't belong to any entity until
 * transferred out of the Pool. The Pool's arithmetic behaves as if it didn't exist, and the BPT total supply is not
 * a useful value: we rely on the 'virtual supply' (how much BPT is actually owned outside the Vault) instead.
 */
contract ComposableStablePool is
    IRateProvider,
    IVersion,
    BaseGeneralPool,
    StablePoolAmplification,
    ComposableStablePoolRates,
    ComposableStablePoolProtocolFees
{
    using FixedPoint for uint256;
    using PriceRateCache for bytes32;
    using StablePoolUserData for bytes;
    using BasePoolUserData for bytes;

    // The maximum imposed by the Vault, which stores balances in a packed format, is 2**(112) - 1.
    // We are preminting half of that value (rounded up).
    uint256 private constant _PREMINTED_TOKEN_BALANCE = 2**(111);

    string private _version;

    // The constructor arguments are received in a struct to work around stack-too-deep issues
    struct NewPoolParams {
        IVault vault;
        IProtocolFeePercentagesProvider protocolFeeProvider;
        string name;
        string symbol;
        IERC20[] tokens;
        IRateProvider[] rateProviders;
        uint256[] tokenRateCacheDurations;
        bool[] exemptFromYieldProtocolFeeFlags;
        uint256 amplificationParameter;
        uint256 swapFeePercentage;
        uint256 pauseWindowDuration;
        uint256 bufferPeriodDuration;
        address owner;
        string version;
    }

    constructor(NewPoolParams memory params)
        BasePool(
            params.vault,
            IVault.PoolSpecialization.GENERAL,
            params.name,
            params.symbol,
            _insertSorted(params.tokens, IERC20(this)),
            new address[](params.tokens.length + 1),
            params.swapFeePercentage,
            params.pauseWindowDuration,
            params.bufferPeriodDuration,
            params.owner
        )
        StablePoolAmplification(params.amplificationParameter)
        ComposableStablePoolStorage(_extractStorageParams(params))
        ComposableStablePoolRates(_extractRatesParams(params))
        ProtocolFeeCache(
            params.protocolFeeProvider,
            ProviderFeeIDs({ swap: ProtocolFeeType.SWAP, yield: ProtocolFeeType.YIELD, aum: ProtocolFeeType.AUM })
        )
    {
        _version = params.version;
    }

    // Translate parameters to avoid stack-too-deep issues in the constructor
    function _extractRatesParams(NewPoolParams memory params)
        private
        pure
        returns (ComposableStablePoolRates.RatesParams memory)
    {
        return
            ComposableStablePoolRates.RatesParams({
                tokens: params.tokens,
                rateProviders: params.rateProviders,
                tokenRateCacheDurations: params.tokenRateCacheDurations
            });
    }

    // Translate parameters to avoid stack-too-deep issues in the constructor
    function _extractStorageParams(NewPoolParams memory params)
        private
        view
        returns (ComposableStablePoolStorage.StorageParams memory)
    {
        return
            ComposableStablePoolStorage.StorageParams({
                registeredTokens: _insertSorted(params.tokens, IERC20(this)),
                tokenRateProviders: params.rateProviders,
                exemptFromYieldProtocolFeeFlags: params.exemptFromYieldProtocolFeeFlags
            });
    }

    function version() external view override returns (string memory) {
        return _version;
    }

    /**
     * @notice Return the minimum BPT balance, required to avoid minimum token balances.
     * @dev This amount is minted and immediately burned on pool initialization, so that the total supply
     * (and therefore post-exit token balances), can never be zero. This keeps the math well-behaved when
     * liquidity is low. (It also provides an easy way to check whether a pool has been initialized, to
     * ensure this is only done once.)
     */
    function getMinimumBpt() external pure returns (uint256) {
        return _getMinimumBpt();
    }

    // BasePool hook

    /**
     * @dev Override base pool hook invoked before any swap, join, or exit to ensure rates are updated before
     * the operation.
     */
    function _beforeSwapJoinExit() internal override {
        super._beforeSwapJoinExit();

        // Before the scaling factors are read, we must update the cached rates, as those will be used to compute the
        // scaling factors.
        // Note that this is not done in a recovery mode exit (since _beforeSwapjoinExit() is not called under those
        // conditions), but this is fine as recovery mode exits are unaffected by scaling factors anyway.
        _cacheTokenRatesIfNecessary();
    }

    // Swap Hooks

    /**
     * @dev Override this hook called by the base class `onSwap`, to check whether we are doing a regular swap,
     * or a swap involving BPT, which is equivalent to a single token join or exit. Since one of the Pool's
     * tokens is the preminted BPT, we need to handle swaps where BPT is involved separately.
     *
     * At this point, the balances are unscaled. The indices are coming from the Vault, so they are indices into
     * the array of registered tokens (including BPT).
     *
     * If this is a swap involving BPT, call `_swapWithBpt`, which computes the amountOut using the swapFeePercentage
     * and charges protocol fees, in the same manner as single token join/exits. Otherwise, perform the default
     * processing for a regular swap.
     */
    function _swapGivenIn(
        SwapRequest memory swapRequest,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut,
        uint256[] memory scalingFactors
    ) internal virtual override returns (uint256) {
        return
            (swapRequest.tokenIn == IERC20(this) || swapRequest.tokenOut == IERC20(this))
                ? _swapWithBpt(swapRequest, registeredBalances, registeredIndexIn, registeredIndexOut, scalingFactors)
                : super._swapGivenIn(
                    swapRequest,
                    registeredBalances,
                    registeredIndexIn,
                    registeredIndexOut,
                    scalingFactors
                );
    }

    /**
     * @dev Override this hook called by the base class `onSwap`, to check whether we are doing a regular swap,
     * or a swap involving BPT, which is equivalent to a single token join or exit. Since one of the Pool's
     * tokens is the preminted BPT, we need to handle swaps where BPT is involved separately.
     *
     * At this point, the balances are unscaled. The indices and balances are coming from the Vault, so they
     * refer to the full set of registered tokens (including BPT).
     *
     * If this is a swap involving BPT, call `_swapWithBpt`, which computes the amountOut using the swapFeePercentage
     * and charges protocol fees, in the same manner as single token join/exits. Otherwise, perform the default
     * processing for a regular swap.
     */
    function _swapGivenOut(
        SwapRequest memory swapRequest,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut,
        uint256[] memory scalingFactors
    ) internal virtual override returns (uint256) {
        return
            (swapRequest.tokenIn == IERC20(this) || swapRequest.tokenOut == IERC20(this))
                ? _swapWithBpt(swapRequest, registeredBalances, registeredIndexIn, registeredIndexOut, scalingFactors)
                : super._swapGivenOut(
                    swapRequest,
                    registeredBalances,
                    registeredIndexIn,
                    registeredIndexOut,
                    scalingFactors
                );
    }

    /**
     * @dev This is called from the base class `_swapGivenIn`, so at this point the amount has been adjusted
     * for swap fees, and balances have had scaling applied. This will only be called for regular (non-BPT) swaps,
     * so forward to `onRegularSwap`.
     */
    function _onSwapGivenIn(
        SwapRequest memory request,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut
    ) internal virtual override returns (uint256) {
        return
            _onRegularSwap(
                true, // given in
                request.amount,
                registeredBalances,
                registeredIndexIn,
                registeredIndexOut
            );
    }

    /**
     * @dev This is called from the base class `_swapGivenOut`, so at this point the amount has been adjusted
     * for swap fees, and balances have had scaling applied. This will only be called for regular (non-BPT) swaps,
     * so forward to `onRegularSwap`.
     */
    function _onSwapGivenOut(
        SwapRequest memory request,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut
    ) internal virtual override returns (uint256) {
        return
            _onRegularSwap(
                false, // given out
                request.amount,
                registeredBalances,
                registeredIndexIn,
                registeredIndexOut
            );
    }

    /**
     * @dev Perform a swap between non-BPT tokens. Scaling and fee adjustments have been performed upstream, so
     * all we need to do here is calculate the price quote, depending on the direction of the swap.
     */
    function _onRegularSwap(
        bool isGivenIn,
        uint256 amountGiven,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut
    ) private view returns (uint256) {
        // Adjust indices and balances for BPT token
        uint256[] memory balances = _dropBptItem(registeredBalances);
        uint256 indexIn = _skipBptIndex(registeredIndexIn);
        uint256 indexOut = _skipBptIndex(registeredIndexOut);

        (uint256 currentAmp, ) = _getAmplificationParameter();
        uint256 invariant = StableMath._calculateInvariant(currentAmp, balances);

        if (isGivenIn) {
            return StableMath._calcOutGivenIn(currentAmp, balances, indexIn, indexOut, amountGiven, invariant);
        } else {
            return StableMath._calcInGivenOut(currentAmp, balances, indexIn, indexOut, amountGiven, invariant);
        }
    }

    /**
     * @dev Perform a swap involving the BPT token, equivalent to a single-token join or exit. As with the standard
     * joins and swaps, we first pay any protocol fees pending from swaps that occurred since the previous join or
     * exit, then perform the operation (joinSwap or exitSwap), and finally store the "post operation" invariant and
     * amp, which establishes the new basis for protocol fees.
     *
     * At this point, the scaling factors (including rates) have been computed by the base class, but not yet applied
     * to the balances.
     */
    function _swapWithBpt(
        SwapRequest memory swapRequest,
        uint256[] memory registeredBalances,
        uint256 registeredIndexIn,
        uint256 registeredIndexOut,
        uint256[] memory scalingFactors
    ) private returns (uint256) {
        bool isGivenIn = swapRequest.kind == IVault.SwapKind.GIVEN_IN;

        _upscaleArray(registeredBalances, scalingFactors);
        swapRequest.amount = _upscale(
            swapRequest.amount,
            scalingFactors[isGivenIn ? registeredIndexIn : registeredIndexOut]
        );

        (
            uint256 preJoinExitSupply,
            uint256[] memory balances,
            uint256 currentAmp,
            uint256 preJoinExitInvariant
        ) = _beforeJoinExit(registeredBalances);

        // These calls mutate `balances` so that it holds the post join-exit balances.
        (uint256 amountCalculated, uint256 postJoinExitSupply) = registeredIndexOut == getBptIndex()
            ? _doJoinSwap(
                isGivenIn,
                swapRequest.amount,
                balances,
                _skipBptIndex(registeredIndexIn),
                currentAmp,
                preJoinExitSupply,
                preJoinExitInvariant
            )
            : _doExitSwap(
                isGivenIn,
                swapRequest.amount,
                balances,
                _skipBptIndex(registeredIndexOut),
                currentAmp,
                preJoinExitSupply,
                preJoinExitInvariant
            );

        _updateInvariantAfterJoinExit(
            currentAmp,
            balances,
            preJoinExitInvariant,
            preJoinExitSupply,
            postJoinExitSupply
        );

        return
            isGivenIn
                ? _downscaleDown(amountCalculated, scalingFactors[registeredIndexOut]) // Amount out, round down
                : _downscaleUp(amountCalculated, scalingFactors[registeredIndexIn]); // Amount in, round up
    }

    /**
     * @dev This mutates `balances` so that they become the post-joinswap balances. The StableMath interfaces
     * are different depending on the swap direction, so we forward to the appropriate low-level join function.
     */
    function _doJoinSwap(
        bool isGivenIn,
        uint256 amount,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        return
            isGivenIn
                ? _joinSwapExactTokenInForBptOut(
                    amount,
                    balances,
                    indexIn,
                    currentAmp,
                    actualSupply,
                    preJoinExitInvariant
                )
                : _joinSwapExactBptOutForTokenIn(
                    amount,
                    balances,
                    indexIn,
                    currentAmp,
                    actualSupply,
                    preJoinExitInvariant
                );
    }

    /**
     * @dev Since this is a join, we know the tokenOut is BPT. Since it is GivenIn, we know the tokenIn amount,
     * and must calculate the BPT amount out.
     * We are moving preminted BPT out of the Vault, which increases the virtual supply.
     */
    function _joinSwapExactTokenInForBptOut(
        uint256 amountIn,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        // The StableMath function was created with joins in mind, so it expects a full amounts array. We create an
        // empty one and only set the amount for the token involved.
        uint256[] memory amountsIn = new uint256[](balances.length);
        amountsIn[indexIn] = amountIn;

        uint256 bptOut = StableMath._calcBptOutGivenExactTokensIn(
            currentAmp,
            balances,
            amountsIn,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        balances[indexIn] = balances[indexIn].add(amountIn);
        uint256 postJoinExitSupply = actualSupply.add(bptOut);

        return (bptOut, postJoinExitSupply);
    }

    /**
     * @dev Since this is a join, we know the tokenOut is BPT. Since it is GivenOut, we know the BPT amount,
     * and must calculate the token amount in.
     * We are moving preminted BPT out of the Vault, which increases the virtual supply.
     */
    function _joinSwapExactBptOutForTokenIn(
        uint256 bptOut,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        uint256 amountIn = StableMath._calcTokenInGivenExactBptOut(
            currentAmp,
            balances,
            indexIn,
            bptOut,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        balances[indexIn] = balances[indexIn].add(amountIn);
        uint256 postJoinExitSupply = actualSupply.add(bptOut);

        return (amountIn, postJoinExitSupply);
    }

    /**
     * @dev This mutates balances so that they become the post-exitswap balances. The StableMath interfaces are
     * different depending on the swap direction, so we forward to the appropriate low-level exit function.
     */
    function _doExitSwap(
        bool isGivenIn,
        uint256 amount,
        uint256[] memory balances,
        uint256 indexOut,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        return
            isGivenIn
                ? _exitSwapExactBptInForTokenOut(
                    amount,
                    balances,
                    indexOut,
                    currentAmp,
                    actualSupply,
                    preJoinExitInvariant
                )
                : _exitSwapExactTokenOutForBptIn(
                    amount,
                    balances,
                    indexOut,
                    currentAmp,
                    actualSupply,
                    preJoinExitInvariant
                );
    }

    /**
     * @dev Since this is an exit, we know the tokenIn is BPT. Since it is GivenIn, we know the BPT amount,
     * and must calculate the token amount out.
     * We are moving BPT out of circulation and into the Vault, which decreases the virtual supply.
     */
    function _exitSwapExactBptInForTokenOut(
        uint256 bptAmount,
        uint256[] memory balances,
        uint256 indexOut,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        uint256 amountOut = StableMath._calcTokenOutGivenExactBptIn(
            currentAmp,
            balances,
            indexOut,
            bptAmount,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        balances[indexOut] = balances[indexOut].sub(amountOut);
        uint256 postJoinExitSupply = actualSupply.sub(bptAmount);

        return (amountOut, postJoinExitSupply);
    }

    /**
     * @dev Since this is an exit, we know the tokenIn is BPT. Since it is GivenOut, we know the token amount out,
     * and must calculate the BPT amount in.
     * We are moving BPT out of circulation and into the Vault, which decreases the virtual supply.
     */
    function _exitSwapExactTokenOutForBptIn(
        uint256 amountOut,
        uint256[] memory balances,
        uint256 indexOut,
        uint256 currentAmp,
        uint256 actualSupply,
        uint256 preJoinExitInvariant
    ) internal view returns (uint256, uint256) {
        // The StableMath function was created with exits in mind, so it expects a full amounts array. We create an
        // empty one and only set the amount for the token involved.
        uint256[] memory amountsOut = new uint256[](balances.length);
        amountsOut[indexOut] = amountOut;

        uint256 bptAmount = StableMath._calcBptInGivenExactTokensOut(
            currentAmp,
            balances,
            amountsOut,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        balances[indexOut] = balances[indexOut].sub(amountOut);
        uint256 postJoinExitSupply = actualSupply.sub(bptAmount);

        return (bptAmount, postJoinExitSupply);
    }

    // Join Hooks

    /**
     * Since this Pool has preminted BPT which is stored in the Vault, it cannot simply be minted at construction.
     *
     * We take advantage of the fact that StablePools have an initialization step where BPT is minted to the first
     * account joining them, and perform both actions at once. By minting the entire BPT supply for the initial joiner
     * and then pulling all tokens except those due the joiner, we arrive at the desired state of the Pool holding all
     * BPT except the joiner's.
     */
    function _onInitializePool(
        bytes32,
        address sender,
        address,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal override returns (uint256, uint256[] memory) {
        StablePoolUserData.JoinKind kind = userData.joinKind();
        _require(kind == StablePoolUserData.JoinKind.INIT, Errors.UNINITIALIZED);

        // AmountsIn usually does not include the BPT token; initialization is the one time it has to.
        uint256[] memory amountsInIncludingBpt = userData.initialAmountsIn();
        InputHelpers.ensureInputLengthMatch(amountsInIncludingBpt.length, scalingFactors.length);
        _upscaleArray(amountsInIncludingBpt, scalingFactors);

        (uint256 amp, ) = _getAmplificationParameter();
        uint256[] memory amountsIn = _dropBptItem(amountsInIncludingBpt);
        uint256 invariantAfterJoin = StableMath._calculateInvariant(amp, amountsIn);

        // Set the initial BPT to the value of the invariant
        uint256 bptAmountOut = invariantAfterJoin;

        // BasePool will mint bptAmountOut for the sender: we then also mint the remaining BPT to make up the total
        // supply, and have the Vault pull those tokens from the sender as part of the join.
        // We are only minting half of the maximum value - already an amount many orders of magnitude greater than any
        // conceivable real liquidity - to allow for minting new BPT as a result of regular joins.
        //
        // Note that the sender need not approve BPT for the Vault as the Vault already has infinite BPT allowance for
        // all accounts.
        uint256 initialBpt = _PREMINTED_TOKEN_BALANCE.sub(bptAmountOut);

        _mintPoolTokens(sender, initialBpt);
        amountsInIncludingBpt[getBptIndex()] = initialBpt;

        // Initialization is still a join, so we need to do post-join work.
        _updatePostJoinExit(amp, invariantAfterJoin);

        return (bptAmountOut, amountsInIncludingBpt);
    }

    /**
     * @dev Base pool hook called from `onJoinPool`. Forward to `onJoinExitPool` with `isJoin` set to true.
     */
    function _onJoinPool(
        bytes32,
        address,
        address,
        uint256[] memory registeredBalances,
        uint256,
        uint256,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal override returns (uint256, uint256[] memory) {
        return _onJoinExitPool(true, registeredBalances, scalingFactors, userData);
    }

    /**
     * @dev Base pool hook called from `onExitPool`. Forward to `onJoinExitPool` with `isJoin` set to false.
     * Note that recovery mode exits do not call `_onExitPool`.
     */
    function _onExitPool(
        bytes32,
        address,
        address,
        uint256[] memory registeredBalances,
        uint256,
        uint256,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal override returns (uint256, uint256[] memory) {
        return _onJoinExitPool(false, registeredBalances, scalingFactors, userData);
    }

    /**
     * @dev Pay protocol fees before the operation, and call `_updateInvariantAfterJoinExit` afterward, to establish
     * the new basis for protocol fees.
     */
    function _onJoinExitPool(
        bool isJoin,
        uint256[] memory registeredBalances,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal returns (uint256, uint256[] memory) {
        (
            uint256 preJoinExitSupply,
            uint256[] memory balances,
            uint256 currentAmp,
            uint256 preJoinExitInvariant
        ) = _beforeJoinExit(registeredBalances);


            function(uint256[] memory, uint256, uint256, uint256, uint256[] memory, bytes memory)
                internal
                view
                returns (uint256, uint256[] memory) _doJoinOrExit
         = (isJoin ? _doJoin : _doExit);

        (uint256 bptAmount, uint256[] memory amountsDelta) = _doJoinOrExit(
            balances,
            currentAmp,
            preJoinExitSupply,
            preJoinExitInvariant,
            scalingFactors,
            userData
        );

        // Unlike joinswaps, explicit joins do not mutate balances into the post join-exit balances so we must perform
        // this mutation here.
        function(uint256, uint256) internal pure returns (uint256) _addOrSub = isJoin ? FixedPoint.add : FixedPoint.sub;
        _mutateAmounts(balances, amountsDelta, _addOrSub);
        uint256 postJoinExitSupply = _addOrSub(preJoinExitSupply, bptAmount);

        // Pass in the post-join balances to reset the protocol fee basis.
        // We are minting bptAmount, increasing the total (and virtual) supply post-join
        _updateInvariantAfterJoinExit(
            currentAmp,
            balances,
            preJoinExitInvariant,
            preJoinExitSupply,
            postJoinExitSupply
        );

        // For clarity and simplicity, arrays used and computed in lower level functions do not include BPT.
        // But the amountsIn array passed back to the Vault must include BPT, so we add it back in here.
        return (bptAmount, _addBptItem(amountsDelta, 0));
    }

    /**
     * @dev Pay any due protocol fees and calculate values necessary for performing the join/exit.
     */
    function _beforeJoinExit(uint256[] memory registeredBalances)
        internal
        returns (
            uint256,
            uint256[] memory,
            uint256,
            uint256
        )
    {
        (uint256 lastJoinExitAmp, uint256 lastPostJoinExitInvariant) = getLastJoinExitData();
        (
            uint256 preJoinExitSupply,
            uint256[] memory balances,
            uint256 oldAmpPreJoinExitInvariant
        ) = _payProtocolFeesBeforeJoinExit(registeredBalances, lastJoinExitAmp, lastPostJoinExitInvariant);

        // If the amplification factor is the same as it was during the last join/exit then we can reuse the
        // value calculated using the "old" amplification factor. If not, then we have to calculate this now.
        (uint256 currentAmp, ) = _getAmplificationParameter();
        uint256 preJoinExitInvariant = currentAmp == lastJoinExitAmp
            ? oldAmpPreJoinExitInvariant
            : StableMath._calculateInvariant(currentAmp, balances);

        return (preJoinExitSupply, balances, currentAmp, preJoinExitInvariant);
    }

    /**
     * @dev Support single- and multi-token joins, plus explicit proportional joins.
     */
    function _doJoin(
        uint256[] memory balances,
        uint256 currentAmp,
        uint256 preJoinExitSupply,
        uint256 preJoinExitInvariant,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal view returns (uint256, uint256[] memory) {
        StablePoolUserData.JoinKind kind = userData.joinKind();
        if (kind == StablePoolUserData.JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT) {
            return
                _joinExactTokensInForBPTOut(
                    preJoinExitSupply,
                    preJoinExitInvariant,
                    currentAmp,
                    balances,
                    scalingFactors,
                    userData
                );
        } else if (kind == StablePoolUserData.JoinKind.ALL_TOKENS_IN_FOR_EXACT_BPT_OUT) {
            return _joinAllTokensInForExactBptOut(preJoinExitSupply, balances, userData);
        } else if (kind == StablePoolUserData.JoinKind.TOKEN_IN_FOR_EXACT_BPT_OUT) {
            return _joinTokenInForExactBPTOut(preJoinExitSupply, preJoinExitInvariant, currentAmp, balances, userData);
        } else {
            _revert(Errors.UNHANDLED_JOIN_KIND);
        }
    }

    /**
     * @dev Proportional join. Pays no swap fees.
     */
    function _joinAllTokensInForExactBptOut(
        uint256 actualSupply,
        uint256[] memory balances,
        bytes memory userData
    ) private pure returns (uint256, uint256[] memory) {
        uint256 bptAmountOut = userData.allTokensInForExactBptOut();
        uint256[] memory amountsIn = BasePoolMath.computeProportionalAmountsIn(balances, actualSupply, bptAmountOut);

        return (bptAmountOut, amountsIn);
    }

    /**
     * @dev Multi-token join. Joins with proportional amounts will pay no protocol fees.
     */
    function _joinExactTokensInForBPTOut(
        uint256 actualSupply,
        uint256 preJoinExitInvariant,
        uint256 currentAmp,
        uint256[] memory balances,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) private view returns (uint256, uint256[] memory) {
        (uint256[] memory amountsIn, uint256 minBPTAmountOut) = userData.exactTokensInForBptOut();
        InputHelpers.ensureInputLengthMatch(balances.length, amountsIn.length);

        // The user-provided amountsIn is unscaled, so we address that.
        _upscaleArray(amountsIn, _dropBptItem(scalingFactors));

        uint256 bptAmountOut = StableMath._calcBptOutGivenExactTokensIn(
            currentAmp,
            balances,
            amountsIn,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        _require(bptAmountOut >= minBPTAmountOut, Errors.BPT_OUT_MIN_AMOUNT);

        return (bptAmountOut, amountsIn);
    }

    /**
     * @dev Single-token join, equivalent to swapping a pool token for BPT.
     */
    function _joinTokenInForExactBPTOut(
        uint256 actualSupply,
        uint256 preJoinExitInvariant,
        uint256 currentAmp,
        uint256[] memory balances,
        bytes memory userData
    ) private view returns (uint256, uint256[] memory) {
        // Since this index is sent in from the user, we interpret it as NOT including the BPT token.
        (uint256 bptAmountOut, uint256 tokenIndex) = userData.tokenInForExactBptOut();
        // Note that there is no maximum amountIn parameter: this is handled by `IVault.joinPool`.

        // Balances are passed through from the Vault hook, and include BPT
        _require(tokenIndex < balances.length, Errors.OUT_OF_BOUNDS);

        // We join with a single token, so initialize amountsIn with zeros.
        uint256[] memory amountsIn = new uint256[](balances.length);

        // And then assign the result to the selected token.
        amountsIn[tokenIndex] = StableMath._calcTokenInGivenExactBptOut(
            currentAmp,
            balances,
            tokenIndex,
            bptAmountOut,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        return (bptAmountOut, amountsIn);
    }

    // Exit Hooks

    /**
     * @dev Support single- and multi-token exits, plus explicit proportional exits (in addition to the
     * recovery mode exit).
     */
    function _doExit(
        uint256[] memory balances,
        uint256 currentAmp,
        uint256 preJoinExitSupply,
        uint256 preJoinExitInvariant,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal view returns (uint256, uint256[] memory) {
        StablePoolUserData.ExitKind kind = userData.exitKind();
        if (kind == StablePoolUserData.ExitKind.BPT_IN_FOR_EXACT_TOKENS_OUT) {
            return
                _exitBPTInForExactTokensOut(
                    preJoinExitSupply,
                    preJoinExitInvariant,
                    currentAmp,
                    balances,
                    scalingFactors,
                    userData
                );
        } else if (kind == StablePoolUserData.ExitKind.EXACT_BPT_IN_FOR_ALL_TOKENS_OUT) {
            return _exitExactBPTInForTokensOut(preJoinExitSupply, balances, userData);
        } else if (kind == StablePoolUserData.ExitKind.EXACT_BPT_IN_FOR_ONE_TOKEN_OUT) {
            return _exitExactBPTInForTokenOut(preJoinExitSupply, preJoinExitInvariant, currentAmp, balances, userData);
        } else {
            _revert(Errors.UNHANDLED_EXIT_KIND);
        }
    }

    /**
     * @dev Proportional exit. Pays no swap fees. This is functionally equivalent to the recovery mode exit,
     * except this doesn't skip protocol fee collection, calling rate providers, etc., and doesn't require
     * recovery mode to be enabled.
     */
    function _exitExactBPTInForTokensOut(
        uint256 actualSupply,
        uint256[] memory balances,
        bytes memory userData
    ) private pure returns (uint256, uint256[] memory) {
        uint256 bptAmountIn = userData.exactBptInForTokensOut();
        uint256[] memory amountsOut = BasePoolMath.computeProportionalAmountsOut(balances, actualSupply, bptAmountIn);

        return (bptAmountIn, amountsOut);
    }

    /**
     * @dev Multi-token exit. Proportional exits will pay no protocol fees.
     */
    function _exitBPTInForExactTokensOut(
        uint256 actualSupply,
        uint256 preJoinExitInvariant,
        uint256 currentAmp,
        uint256[] memory balances,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) private view returns (uint256, uint256[] memory) {
        (uint256[] memory amountsOut, uint256 maxBPTAmountIn) = userData.bptInForExactTokensOut();
        InputHelpers.ensureInputLengthMatch(amountsOut.length, balances.length);

        // The user-provided amountsIn is unscaled, so we address that.
        _upscaleArray(amountsOut, _dropBptItem(scalingFactors));

        uint256 bptAmountIn = StableMath._calcBptInGivenExactTokensOut(
            currentAmp,
            balances,
            amountsOut,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );
        _require(bptAmountIn <= maxBPTAmountIn, Errors.BPT_IN_MAX_AMOUNT);

        return (bptAmountIn, amountsOut);
    }

    /**
     * @dev Single-token exit, equivalent to swapping BPT for a pool token.
     */
    function _exitExactBPTInForTokenOut(
        uint256 actualSupply,
        uint256 preJoinExitInvariant,
        uint256 currentAmp,
        uint256[] memory balances,
        bytes memory userData
    ) private view returns (uint256, uint256[] memory) {
        // Since this index is sent in from the user, we interpret it as NOT including the BPT token
        (uint256 bptAmountIn, uint256 tokenIndex) = userData.exactBptInForTokenOut();
        // Note that there is no minimum amountOut parameter: this is handled by `IVault.exitPool`.

        _require(tokenIndex < balances.length, Errors.OUT_OF_BOUNDS);

        // We exit in a single token, so initialize amountsOut with zeros
        uint256[] memory amountsOut = new uint256[](balances.length);

        // And then assign the result to the selected token.
        amountsOut[tokenIndex] = StableMath._calcTokenOutGivenExactBptIn(
            currentAmp,
            balances,
            tokenIndex,
            bptAmountIn,
            actualSupply,
            preJoinExitInvariant,
            getSwapFeePercentage()
        );

        return (bptAmountIn, amountsOut);
    }

    function _doRecoveryModeExit(
        uint256[] memory registeredBalances,
        uint256,
        bytes memory userData
    ) internal view override returns (uint256, uint256[] memory) {
        // Since this Pool uses preminted BPT, we need to replace the total supply with the virtual total supply, and
        // adjust the balances array by removing BPT from it.
        // Note that we don't compute the actual supply, which would require a lot of complex calculations and
        // interactions with external components. This is fine because virtual and actual supply are the same while
        // recovery mode is enabled (since all protocol fees are forfeit and the fee percentages zeroed out).
        (uint256 virtualSupply, uint256[] memory balances) = _dropBptItemFromBalances(registeredBalances);

        uint256 bptAmountIn = userData.recoveryModeExit();
        uint256[] memory amountsOut = new uint256[](balances.length);

        uint256 bptRatio = bptAmountIn.divDown(virtualSupply);
        for (uint256 i = 0; i < balances.length; i++) {
            amountsOut[i] = balances[i].mulDown(bptRatio);
        }

        // The vault requires an array including BPT, so add it back in here.
        return (bptAmountIn, _addBptItem(amountsOut, 0));
    }

    // BPT rate

    /**
     * Many functions require accessing multiple internal values that might at first seem unrelated, but are actually
     * quite intertwined, and computed at the same time for optimal performance (since calculating some of them also
     * yields intermediate results useful for other queries). This helper function returns many of these values,
     * greatly reducing bytecode size.
     *
     * The return values are:
     *  @return balances - The current upscaled token balances (not including BPT)
     *  @return virtualSupply - The Pool's virtual supply
     *  @return protocolFeeAmount - The amount of unpaid protocol fees in BPT
     *  @return lastJoinExitAmp - The Pool's amplification factor at the last join or exit operation
     *  @return currentInvariantWithLastJoinExitAmp - The invariant of the current balances, calculated using the
     *  amplification factor at the last join or exit operation.
     */
    function _getSupplyAndFeesData()
        private
        view
        returns (
            uint256[] memory balances,
            uint256 virtualSupply,
            uint256 protocolFeeAmount,
            uint256 lastJoinExitAmp,
            uint256 currentInvariantWithLastJoinExitAmp
        )
    {
        // First we query the Vault for current registered balances (which includes preminted BPT), to then calculate
        // the current scaled balances and virtual supply.
        (, uint256[] memory registeredBalances, ) = getVault().getPoolTokens(getPoolId());
        _upscaleArray(registeredBalances, _scalingFactors());
        (virtualSupply, balances) = _dropBptItemFromBalances(registeredBalances);

        // Now we need to calculate any BPT due in the form of protocol fees. This requires data from the last join or
        // exit operation. `lastJoinExitAmp` can be useful in the scenario in which the amplification factor has not
        // changed, meaning this old value is equal to the current value.
        uint256 lastPostJoinExitInvariant;
        (lastJoinExitAmp, lastPostJoinExitInvariant) = getLastJoinExitData();

        // Computing the protocol ownership percentage also yields the invariant using the old amplification factor. If
        // it has not changed, then this is also the current invariant.
        uint256 expectedProtocolOwnershipPercentage;
        (
            expectedProtocolOwnershipPercentage,
            currentInvariantWithLastJoinExitAmp
        ) = _getProtocolPoolOwnershipPercentage(balances, lastJoinExitAmp, lastPostJoinExitInvariant);

        protocolFeeAmount = ExternalFees.bptForPoolOwnershipPercentage(
            virtualSupply,
            expectedProtocolOwnershipPercentage
        );
    }

    /**
     * @dev This function returns the appreciation of BPT relative to the underlying tokens, as an 18 decimal fixed
     * point number. It is simply the ratio of the invariant to the BPT supply.
     *
     * The total supply is initialized to equal the invariant, so this value starts at one. During Pool operation the
     * invariant always grows and shrinks either proportionally to the total supply (in scenarios with no price impact,
     * e.g. proportional joins), or grows faster and shrinks more slowly than it (whenever swap fees are collected or
     * the token rates increase). Therefore, the rate is a monotonically increasing function *as long as the tokens
     * in the pool do not lose value*.
     *
     * Since the invariant is ultimately a function of the token balances and their respective rates (for yield-bearing
     * tokens with rate providers), the rate of the pool might go down under certain circumstances (e.g. if the rate
     * of the tokens goes down). Therefore, it cannot be assumed this function is always monotonically increasing for
     * any pool with rate providers. This should only be the case when all the tokens in the pool have monotonically
     * increasing rates, which ultimately depends on the nature of the tokens and their rate providers.
     *
     * WARNING: since this function reads balances directly from the Vault, it is potentially subject to manipulation
     * via reentrancy if called within a Vault context (i.e. in the middle of a join or an exit). It is up to the
     * caller to ensure that the function is safe to call.
     *
     * This may happen e.g. if one of the tokens in the Pool contains some form of callback behavior in the
     * `transferFrom` function (like ERC777 tokens do). These tokens are strictly incompatible with the
     * Vault and Pool design, and are not safe to be used.
     *
     * There are also other situations where calling this function is unsafe. See
     * https://forum.balancer.fi/t/reentrancy-vulnerability-scope-expanded/4345 for reference.
     *
     * To call this function safely, attempt to trigger the reentrancy guard in the Vault by calling a non-reentrant
     * function before calling `getRate`. That will make the transaction revert in an unsafe context.
     * (See `VaultReentrancyLib.ensureNotInVaultContext` in pool-utils.)
     */
    function getRate() external view virtual override returns (uint256) {
        // We need to compute the current invariant and actual total supply. The latter includes protocol fees that have
        // accrued but are not yet minted: in calculating these we'll actually end up fetching most of the data we need
        // for the invariant.

        (
            uint256[] memory balances,
            uint256 virtualSupply,
            uint256 protocolFeeAmount,
            uint256 lastJoinExitAmp,
            uint256 currentInvariantWithLastJoinExitAmp
        ) = _getSupplyAndFeesData();

        // Due protocol fees will be minted at the next join or exit, so we can simply add them to the current virtual
        // supply to get the actual supply.
        uint256 actualTotalSupply = virtualSupply.add(protocolFeeAmount);

        // All that's missing now is the invariant. We have the balances required to calculate it already, but still
        // need the current amplification factor.
        (uint256 currentAmp, ) = _getAmplificationParameter();

        // It turns out that the process for due protocol fee calculation involves computing the current invariant,
        // except using the amplification factor at the last join or exit. This would typically not be terribly useful,
        // but since the amplification factor only changes rarely there is high probability of its current value being
        // the same as it was in the last join or exit. If that is the case, then we can skip the costly invariant
        // computation altogether.
        uint256 currentInvariant = (currentAmp == lastJoinExitAmp)
            ? currentInvariantWithLastJoinExitAmp
            : StableMath._calculateInvariant(currentAmp, balances);

        // With the current invariant and actual total supply, we can compute the rate as a fixed-point number.
        return currentInvariant.divDown(actualTotalSupply);
    }

    /**
     * @dev Returns the effective BPT supply.
     *
     * In other pools, this would be the same as `totalSupply`, but there are two key differences here:
     *  - this pool pre-mints BPT and holds it in the Vault as a token, and as such we need to subtract the Vault's
     *    balance to get the total "circulating supply". This is called the 'virtualSupply'.
     *  - the Pool owes debt to the Protocol in the form of unminted BPT, which will be minted immediately before the
     *    next join or exit. We need to take these into account since, even if they don't yet exist, they will
     *    effectively be included in any Pool operation that involves BPT.
     *
     * In the vast majority of cases, this function should be used instead of `totalSupply()`.
     *
     * **IMPORTANT NOTE**: calling this function within a Vault context (i.e. in the middle of a join or an exit) is
     * potentially unsafe, since the returned value is manipulable. It is up to the caller to ensure safety.
     *
     * This is because this function calculates the invariant, which requires the state of the pool to be in sync
     * with the state of the Vault. That condition may not be true in the middle of a join or an exit.
     *
     * To call this function safely, attempt to trigger the reentrancy guard in the Vault by calling a non-reentrant
     * function before calling `getActualSupply`. That will make the transaction revert in an unsafe context.
     * (See `VaultReentrancyLib.ensureNotInVaultContext` in pool-utils.)
     *
     * See https://forum.balancer.fi/t/reentrancy-vulnerability-scope-expanded/4345 for reference.
     */
    function getActualSupply() external view returns (uint256) {
        (, uint256 virtualSupply, uint256 protocolFeeAmount, , ) = _getSupplyAndFeesData();
        return virtualSupply.add(protocolFeeAmount);
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

        // We need to calculate the amount of unminted BPT that represents protocol fees to then pay those. This yields
        // some auxiliary values that turn out to also be useful for the rest of the tasks we want to perform.
        (
            uint256[] memory balances,
            ,
            uint256 protocolFeeAmount,
            uint256 lastJoinExitAmp,
            uint256 currentInvariantWithLastJoinExitAmp
        ) = _getSupplyAndFeesData();

        _payProtocolFees(protocolFeeAmount);

        // With the fees paid, we now need to calculate the current invariant so we can store it alongside the current
        // amplification factor, marking the Pool as free of protocol debt.
        (uint256 currentAmp, ) = _getAmplificationParameter();

        // It turns out that the process for due protocol fee calculation involves computing the current invariant,
        // except using the amplification factor at the last join or exit. This would typically not be terribly useful,
        // but since the amplification factor only changes rarely there is high probability of its current value being
        // the same as it was in the last join or exit. If that is the case, then we can skip the costly invariant
        // computation altogether.
        uint256 currentInvariant = (currentAmp == lastJoinExitAmp)
            ? currentInvariantWithLastJoinExitAmp
            : StableMath._calculateInvariant(currentAmp, balances);

        _updatePostJoinExit(currentAmp, currentInvariant);
    }

    function _onDisableRecoveryMode() internal override {
        // Enabling recovery mode short-circuits protocol fee computations, forcefully returning a zero percentage,
        // increasing the return value of `getRate()` and effectively forfeiting due protocol fees.

        // Therefore, when exiting recovery mode we store the current invariant and the amplification factor used to
        // compute it, marking the Pool as free of protocol debt. Otherwise it'd be possible for debt to be
        // retroactively accrued, which would be incorrect and could lead to the value of `getRate` decreasing.

        (, uint256[] memory registeredBalances, ) = getVault().getPoolTokens(getPoolId());
        _upscaleArray(registeredBalances, _scalingFactors());
        uint256[] memory balances = _dropBptItem(registeredBalances);

        (uint256 currentAmp, ) = _getAmplificationParameter();
        uint256 currentInvariant = StableMath._calculateInvariant(currentAmp, balances);

        _updatePostJoinExit(currentAmp, currentInvariant);
    }

    // Helpers

    /**
     * @dev Mutates `amounts` by applying `mutation` with each entry in `arguments`.
     *
     * Equivalent to `amounts = amounts.map(mutation)`.
     */
    function _mutateAmounts(
        uint256[] memory toMutate,
        uint256[] memory arguments,
        function(uint256, uint256) pure returns (uint256) mutation
    ) private pure {
        uint256 length = toMutate.length;
        InputHelpers.ensureInputLengthMatch(length, arguments.length);

        for (uint256 i = 0; i < length; ++i) {
            toMutate[i] = mutation(toMutate[i], arguments[i]);
        }
    }

    // Permissioned functions

    /**
     * @dev Inheritance rules still require us to override this in the most derived contract, even though
     * it only calls super.
     */
    function _isOwnerOnlyAction(bytes32 actionId)
        internal
        view
        virtual
        override(
            // Our inheritance pattern creates a small diamond that requires explicitly listing the parents here.
            // Each parent calls the `super` version, so linearization ensures all implementations are called.
            BasePool,
            ComposableStablePoolProtocolFees,
            StablePoolAmplification,
            ComposableStablePoolRates
        )
        returns (bool)
    {
        return super._isOwnerOnlyAction(actionId);
    }
}
