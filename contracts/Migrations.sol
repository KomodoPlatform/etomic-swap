// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/access/Ownable.sol";

contract Migrations is Ownable {
  uint256 public lastCompletedMigration;

  constructor() Ownable(msg.sender) {}

  function setCompleted(uint256 completed) public onlyOwner {
    lastCompletedMigration = completed;
  }

  function upgrade(address newAddress) public onlyOwner {
    Migrations upgraded = Migrations(newAddress);
    upgraded.setCompleted(lastCompletedMigration);
  }
}