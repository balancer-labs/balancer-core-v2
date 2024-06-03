pragma solidity ^0.7.0;

import "./LinearMath.sol";

contract EchidnaBase {
    event AssertionFailed(string reason);

    function Assert(bool condition, string memory reason) internal {
        if (!condition) {
            emit AssertionFailed(reason);
        }
    }

    function Failed(string memory reason) internal {
        emit AssertionFailed(reason);
    }
}


contract LinearMathEchidna is LinearMath, EchidnaBase {

    event LogCall2(
        uint256 fee, uint256 rate, uint256 lowerTarget, uint256 upperTarget,
        string fnName, 
        uint256 input, 
        uint256 mainBalance,
        uint256 output
    );

    event LogCall4(
        uint256 fee, uint256 rate, uint256 lowerTarget, uint256 upperTarget,
        string fnName, 
        uint256 input, 
        uint256 mainBalance, uint256 wrappedBalance, uint256 bptSupply, 
        uint256 output
    );

    // uint256 private constant MAX_PROTOCOL_SWAP_FEE_PERCENTAGE = 50e16; // 50% 
    uint private constant RATE = 1e18;
    // uint private constant MAX_TOKEN_BALANCE = 2**(112) - 1;

    function realisticFee(uint256 fee) internal pure returns (uint256) { // range: [0, 1]
        // 1e18 = 100%, 1e17 = 10%, 1e16 = 1%, 1e15 = 0.1%, 1e14 = 0.01%
        // between 0.01% and 10%
        return uint256(fee % (1e17));
    }

    function realisticTargetRange(uint256 lowerTarget, uint256 upperTarget) internal pure returns (uint256, uint256) {
        // between 1,000,000 and 3,000,000 tokens
        lowerTarget = 1000000e18 + lowerTarget % (5000000e18 - 1000000e18 - 1);
        upperTarget = lowerTarget + upperTarget % (5000000e18 - lowerTarget);
        return (lowerTarget, upperTarget);
    }

    function realisticBalance(uint256 balance) internal pure returns (uint256) {
        // between 0 and 3,000,000 tokens
        return uint256(balance % (3000000e18));
    }

    function realisticOutIncludingZero(uint256 out) internal pure returns (uint256) {
        // between 0 and 100,000 tokens
        return uint256(out % (100000e18));
    }
    function realisticOutAboveOne(uint256 out) internal pure returns (uint256) {
        // between 1 and 100,000 tokens
        return uint256(1e18 + out % (100000e18 - 1e18));
    }

    function calcBptOutPerMainIn(
        // uint256 mainIn,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint bptOut = _calcBptOutPerMainIn(
            0,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcBptOutPerMainIn',
            0, mainBalance, wrappedBalance, bptSupply, bptOut
        );
        
        if (bptOut > 0) Failed('free bptOut');
    }

    function calcBptInPerMainOut(
        uint256 mainOut,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);
        
        mainOut = realisticOutAboveOne(mainOut);
        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint bptIn = _calcBptInPerMainOut(
            mainOut,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcBptInPerMainOut',
            mainOut, mainBalance, wrappedBalance, bptSupply, bptIn
        );

        if (bptIn == 0) Failed('free mainOut for zero bptIn');
    }

    function calcWrappedOutPerMainIn(
        // uint256 mainIn,
        uint256 mainBalance,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);

        uint wrappedOut = _calcWrappedOutPerMainIn(
            0,
            mainBalance,
            params
        );

        emit LogCall2(
            fee, RATE, lowerTarget, upperTarget,
            'calcWrappedOutPerMainIn',
            0, mainBalance, wrappedOut
        );

        if (wrappedOut > 0) Failed('free wrappedOut');
    }

    function calcWrappedInPerMainOut(
        uint256 mainOut,
        uint256 mainBalance,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainOut = realisticOutAboveOne(mainOut);
        mainBalance = realisticBalance(mainBalance);

        uint wrappedIn = _calcWrappedInPerMainOut(
            mainOut,
            mainBalance,
            params
        );

        emit LogCall2(
            fee, RATE, lowerTarget, upperTarget,
            'calcWrappedInPerMainOut',
            mainOut, mainBalance, wrappedIn
        );

        if (wrappedIn == 0) Failed('free mainOut for zero wrappedIn');
    }

    function calcMainInPerBptOut(
        uint256 bptOut,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        if (bptOut == 0) return;
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        // require(bptSupply <= MAX_TOKEN_BALANCE);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint mainIn = _calcMainInPerBptOut(
            uint256(bptOut),
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcMainInPerBptOut',
            uint256(bptOut), mainBalance, wrappedBalance, bptSupply, mainIn
        );

        if (mainIn == 0) Failed('free bptOut for zero mainIn');
    }

    function calcMainOutPerBptIn(
        // uint256 bptIn,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        // require(bptSupply <= MAX_TOKEN_BALANCE);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint mainOut = _calcMainOutPerBptIn(
            0,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcMainOutPerBptIn',
            0, mainBalance, wrappedBalance, bptSupply, mainOut
        );

        if (mainOut > 0) Failed('free mainOut');
    }

    function calcMainOutPerWrappedIn(
        // uint256 wrappedIn,
        uint256 mainBalance,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);

        uint mainOut = _calcMainOutPerWrappedIn(
            0,
            mainBalance,
            params
        );

        emit LogCall2(
            fee, RATE, lowerTarget, upperTarget,
            'calcMainOutPerWrappedIn',
            0, mainBalance, mainOut
        );

        if (mainOut > 0) Failed('free mainOut');
    }

    function calcMainInPerWrappedOut(
        uint256 wrappedOut,
        uint256 mainBalance,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        wrappedOut = realisticOutAboveOne(wrappedOut);
        mainBalance = realisticBalance(mainBalance);

        uint mainIn = _calcMainInPerWrappedOut(
            wrappedOut,
            mainBalance,
            params
        );

        emit LogCall2(
            fee, RATE, lowerTarget, upperTarget,
            'calcMainInPerWrappedOut',
            wrappedOut, mainBalance, mainIn
        );

        if (mainIn == 0) Failed('free wrappedOut for zero mainIn');
    }

    function calcBptOutPerWrappedIn(
        // uint256 wrappedIn,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint bptOut = _calcBptOutPerWrappedIn(
            0,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcBptOutPerWrappedIn',
            0, mainBalance, wrappedBalance, bptSupply, bptOut
        );

        if (bptOut > 0) Failed('free bptOut');
    }

    function calcBptInPerWrappedOut(
        uint256 wrappedOut,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint bptIn = _calcBptInPerWrappedOut(
            uint256(wrappedOut),
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcBptInPerWrappedOut',
            uint256(wrappedOut), mainBalance, wrappedBalance, bptSupply, bptIn
        );

        if (wrappedOut > 0 && bptIn == 0) Failed('free wrappedOut for zero bptIn');
    }

    function calcWrappedInPerBptOut(
        uint256 bptOut,
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        bptOut = realisticOutIncludingZero(bptOut);
        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint wrappedIn = _calcWrappedInPerBptOut(
            bptOut,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcWrappedInPerBptOut',
            bptOut, mainBalance, wrappedBalance, bptSupply, wrappedIn
        );

        if (wrappedIn == 0) Failed('free bptOut for zero wrappedIn');
    }

    function calcWrappedOutPerBptIn(
        uint256 mainBalance,
        uint256 wrappedBalance,
        uint256 bptSupply,
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget);
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);

        mainBalance = realisticBalance(mainBalance);
        wrappedBalance = realisticBalance(wrappedBalance);
        bptSupply = realisticBalance(bptSupply);

        uint wrappedOut = _calcWrappedOutPerBptIn(
            0,
            mainBalance,
            wrappedBalance,
            bptSupply,
            params
        );

        emit LogCall4(
            fee, RATE, lowerTarget, upperTarget,
            'calcWrappedOutPerBptIn',
            0, mainBalance, wrappedBalance, bptSupply, wrappedOut
        );

        if (wrappedOut > 0) Failed('free wrappedOut');
    }

    event LogNominals(uint256, uint256);
    function nominal(
        uint256 val, 
        uint256 fee, uint256 lowerTarget, uint256 upperTarget
    ) public {
        fee = realisticFee(fee);
        (lowerTarget, upperTarget) = realisticTargetRange(lowerTarget, upperTarget); // test execution removing this
        LinearMath.Params memory params = LinearMath.Params(fee, RATE, lowerTarget, upperTarget);
        uint256 toNominal = _toNominal(val, params);
        uint256 fromNominal = _fromNominal(toNominal, params);
        if (val != fromNominal) {
            emit LogNominals(toNominal, fromNominal);
            if (fromNominal > val) {
                Assert((fromNominal- val) < 1e8, 'toNominal much bigger than val');
            } else {
                Assert((val- fromNominal) < 1e8, 'val much bigger than toNominal');
            }
        }
    }
}
