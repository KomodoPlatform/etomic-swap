// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Erc721Token is ERC721, Ownable {
    constructor(string memory tokenName, string memory tokenSymbol)
        ERC721(tokenName, tokenSymbol)
        Ownable(msg.sender)  // Initialize Ownable with the deployer address
    {
        uint256 tokenId = 1;
        _mint(msg.sender, tokenId);
    }

    // Public mint function
    function mint(address to, uint256 tokenId) public onlyOwner {
        _mint(to, tokenId);
    }
}
