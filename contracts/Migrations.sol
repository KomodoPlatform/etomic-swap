// SPDX-License-Identifier: MIT

pragma solidity ^0.8.23;
import "@openzeppelin/contracts/access/Ownable.sol";

contract Migrations is Ownable {
  uint256 public last_completed_migration;

  constructor() Ownable(msg.sender) {}

  function setCompleted(uint256 completed) public onlyOwner {
    last_completed_migration = completed;
  }

  function upgrade(address new_address) public onlyOwner {
    Migrations upgraded = Migrations(new_address);
    upgraded.setCompleted(last_completed_migration);
  }
}
