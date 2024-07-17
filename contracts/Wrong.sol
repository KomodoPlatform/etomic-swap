// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

contract Wrong {
    uint256 private x = 1;

    function getX() public view returns (uint256) {
	    return x;
    }
}