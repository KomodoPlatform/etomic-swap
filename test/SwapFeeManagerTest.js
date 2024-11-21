const { expect } = require("chai");
const { ethers } = require("hardhat");
require('chai').use(require('chai-as-promised')).should();

describe("SwapFeeManager", function () {
    beforeEach(async function () {
        accounts = await ethers.getSigners();

        SwapFeeManager = await ethers.getContractFactory("SwapFeeManager");
        swapFeeManager = await SwapFeeManager.deploy(
            accounts[2].address, // dexFeeWallet
            accounts[3].address  // burnFeeWallet
        );
        await swapFeeManager.waitForDeployment();

        Token = await ethers.getContractFactory("Token");
        token = await Token.deploy();
        await token.waitForDeployment();

        await token.transfer(accounts[1].address, ethers.parseEther("100"));
    });

    it("should correctly split and withdraw Ether fees", async function () {
        // Send Ether to the SwapFeeManager contract
        await accounts[1].sendTransaction({
            to: swapFeeManager.target,
            value: ethers.parseEther("1"),
        });

        const managerBalance = await ethers.provider.getBalance(swapFeeManager.target);
        expect(managerBalance).to.equal(ethers.parseEther("1"));

        const initialDexFeeBalance = await ethers.provider.getBalance(accounts[2].address);
        const initialBurnFeeBalance = await ethers.provider.getBalance(accounts[3].address);

        await swapFeeManager.connect(accounts[0]).splitAndWithdraw().should.be.fulfilled;

        const finalDexFeeBalance = await ethers.provider.getBalance(accounts[2].address);
        const finalBurnFeeBalance = await ethers.provider.getBalance(accounts[3].address);

        expect(finalDexFeeBalance - initialDexFeeBalance).to.equal(ethers.parseEther("0.75"));
        expect(finalBurnFeeBalance - initialBurnFeeBalance).to.equal(ethers.parseEther("0.25"));

        // Ensure the contract's Ether balance is now zero
        const managerBalanceAfter = await ethers.provider.getBalance(swapFeeManager.target);
        expect(managerBalanceAfter).to.equal(ethers.parseEther("0"));
    });

    it("should correctly split and withdraw ERC20 token fees", async function () {
        // Approve and transfer tokens to the SwapFeeManager contract
        await token.connect(accounts[1]).approve(swapFeeManager.target, ethers.parseEther("1"));
        await token.connect(accounts[1]).transfer(swapFeeManager.target, ethers.parseEther("1"));

        const managerTokenBalance = await token.balanceOf(swapFeeManager.target);
        expect(managerTokenBalance).to.equal(ethers.parseEther("1"));

        const initialDexFeeTokenBalance = await token.balanceOf(accounts[2].address);
        const initialBurnFeeTokenBalance = await token.balanceOf(accounts[3].address);

        await swapFeeManager.connect(accounts[0]).splitAndWithdrawToken(token.target).should.be.fulfilled;

        const finalDexFeeTokenBalance = await token.balanceOf(accounts[2].address);
        const finalBurnFeeTokenBalance = await token.balanceOf(accounts[3].address);

        // Check balances of dexFeeWallet and burnFeeWallet for tokens
        expect(finalDexFeeTokenBalance - initialDexFeeTokenBalance).to.equal(ethers.parseEther("0.75"));
        expect(finalBurnFeeTokenBalance - initialBurnFeeTokenBalance).to.equal(ethers.parseEther("0.25"));

        // Ensure the contract's token balance is now zero
        const managerTokenBalanceAfter = await token.balanceOf(swapFeeManager.target);
        expect(managerTokenBalanceAfter).to.equal(ethers.parseEther("0"));
    });

    it("should not allow non-owner to split and withdraw Ether fees", async function () {
        await accounts[1].sendTransaction({
            to: swapFeeManager.target,
            value: ethers.parseEther("1"),
        });

        // Attempt to call splitAndWithdraw as a non-owner
        await swapFeeManager.connect(accounts[1]).splitAndWithdraw().should.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should not allow non-owner to split and withdraw ERC20 token fees", async function () {
        await token.connect(accounts[1]).approve(swapFeeManager.target, ethers.parseEther("1"));
        await token.connect(accounts[1]).transfer(swapFeeManager.target, ethers.parseEther("1"));

        // Attempt to call splitAndWithdrawToken as a non-owner
        await swapFeeManager.connect(accounts[1]).splitAndWithdrawToken(token.target).should.be.rejectedWith("OwnableUnauthorizedAccount");
    });
});
