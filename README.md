# Etomic Swap Smart Contracts for Komodo SDK.
[![Build Status](https://travis-ci.org/artemii235/etomic-swap.svg?branch=master)](https://travis-ci.org/artemii235/etomic-swap)  
Etomic swap Smart Contract is implemented to support ETH and ERC20 atomic swaps on Komodo SDK.
Please note that this project is not production ready yet!

## Swap workflow
Smart Contracts follow standard symmetric Atomic swap protocol.  
Despite example shows swap of ETH/ERC20 this approach will work also for ETH/ERC20 swaps to any currency supporting HTLC (https://en.bitcoin.it/wiki/Hashed_Timelock_Contracts).  

1. Bob wants to change his 1 ETH to Alice 1 ERC20 token.
1. Alice sends dexfee (handled externally by client side).
1. Bob sends payment locked with hash of the Secret. He can refund the payment in 4 hours.
1. Alice sends payment locked with Bob Secret hash. She can refund her payment in 2 hours.
1. Bob spends Alice payment by revealing the secret.
1. Alice spends Bob payment using revealed secret.

## Project structure

1. `contracts` - Smart Contracts source code.
1. `migrations` - Deployment scripts.
1. `test` - Smart contracts unit tests.

## How to setup dev environment?

1. Install docker.
1. `cp .env.empty .env`.
1. Run `docker-compose build`.
1. Start containers `docker-compose up -d`.
1. Install project dependencies: `docker-compose exec workspace yarn`.
1. To run tests: `docker-compose exec workspace hardhat test`.
1. To clean artifacts and cache: `docker-compose exec workspace npx hardhat clean`.
1. Stop containers `docker-compose down`.

## Related links

1. Komodo platform - https://www.komodoplatform.com

## Useful links for smart contracts development

1. Truffle suite - https://github.com/trufflesuite/truffle
1. Ganache (EthereumJS Testrpc) - https://github.com/trufflesuite/ganache
1. OpenZeppelin Contracts - https://github.com/OpenZeppelin/openzeppelin-contracts

## Contribution Guide

- Run Docker tests to ensure that the project is set up successfully.
- Write tests for new contracts and functionalities.
- Run tests to confirm that new implementations work correctly.
- Format Solidity code before opening a pull request (PR). For formatting, you can use Remix Online IDE - https://remix.ethereum.org/

## Where Can I Write Solidity Code?

### Notes for Those Without an IDE:
Using Remix Online IDE is sufficient. There's no need to install anything locally.

### Notes for JetBrains or Visual Studio Code (VSCode) Users:
- These IDEs offer Solidity plugins, which can simplify your workflow. However, Remix Online IDE is also a viable option.
- To index JavaScript code, execute the Docker commands as mentioned. Necessary dependencies will be downloaded, enabling the IDE to index the rest of the code.