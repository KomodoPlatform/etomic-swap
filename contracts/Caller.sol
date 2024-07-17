// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "./Calculator.sol";

contract Caller {
    Calculator calculator;

    constructor(address _calc) {
        calculator = Calculator(_calc);
    }

    // call the getSum function in the calculator contract
    function callCalculator() public view returns (uint sum) {
        sum = calculator.getSum();
    }
}
