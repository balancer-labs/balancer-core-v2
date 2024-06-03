// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.0;

import "forge-std/Test.sol";

import "../../contracts/math/LogExpMath.sol";
import "../../contracts/math/ReferenceLogExpMath.sol";

contract LogExpMathsTest is Test {
    function testExpEquivalence(int256 a) external {
        vm.assume(a > ReferenceLogExpMath.MIN_NATURAL_EXPONENT);
        vm.assume(a < ReferenceLogExpMath.MAX_NATURAL_EXPONENT);

        int256 expectedExp = ReferenceLogExpMath.exp(a);
        int256 actualExp = LogExpMath.exp(a);

        assertApproxEqRel(actualExp, expectedExp, 1e2);
    }

    function testLnEquivalence(int256 a) external {
        vm.assume(a > 0);

        int256 expectedLn = ReferenceLogExpMath.ln(a);
        int256 actualLn = LogExpMath.ln(a);

        assertApproxEqAbs(actualLn, expectedLn, 2);
    }
}
