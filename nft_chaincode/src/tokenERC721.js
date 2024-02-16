const { Contract } = require("fabric-contract-api");

// Define names for prefixes
const balancePrefix = "balance";
const nftPrefix = "nft";
const approvalPrefix = "approval";

// Define names for keys
const nameKey = "name";
const symbolKey = "symbol";
const tslog = require("tslog");
const log = new tslog.Logger({});

class TokenERC721Contract extends Contract {

    async Name(ctx) {
        await this.CheckInitialized(ctx);
        const name = await ctx.stub.getState(nameKey);
        return name.toString();
    }

    async Symbol(ctx) {
        await this.CheckInitialized(ctx);
        const symbol = await ctx.stub.getState(symbolKey);
        return symbol.toString();
    }

    async GetToken(ctx, tokenId) {
        await this.CheckInitialized(ctx);
        const nft = await this._readNFT(ctx, tokenId);
        return JSON.stringify(nft);
    }

    async GetTokens(ctx) {
        await this.CheckInitialized(ctx);
        const iterator = await ctx.stub.getStateByPartialCompositeKey(nftPrefix, []);
        const nfts = [];
        let result = await iterator.next();
        while (!result.done) {
            nfts.push(JSON.parse(result.value.value.toString("utf8")));
            result = await iterator.next();
        }
        return JSON.stringify(nfts);
    }

    async TokenURI(ctx, tokenId) {
        await this.CheckInitialized(ctx);
        const nft = await this._readNFT(ctx, tokenId);
        return nft.tokenURI;
    }

    async OwnerOf(ctx, tokenId) {
        await this.CheckInitialized(ctx);
        const nft = await this._readNFT(ctx, tokenId);
        const owner = nft.owner;
        if (!owner) {
            throw new Error("The token doesn't have an owner");
        }
        return owner;
    }

    async ping(ctx) {
        log.info("ping");
        return "pong";
    }

    async BalanceOf(ctx, accountID) {
        await this.CheckInitialized(ctx);

        const iterator = await ctx.stub.getStateByPartialCompositeKey(
            balancePrefix,
            [accountID]
        );

        let balance = 0;
        let result = await iterator.next();

        while (!result.done) {
            balance++;
            result = await iterator.next();
        }
        return balance;
    }

    async Mint(ctx, tokenId, tokenURI, name, description) {
        await this.CheckInitialized(ctx);

        const clientMSID = ctx.clientIdentity.getMSPID();
        if (clientMSID !== "Org1MSP") {
            throw new Error("The client is not authorized to mint tokens");
        }

        const minter = ctx.clientIdentity.getID();
        log.info(minter, "MINTER");

        const exists = await this._nftExists(ctx, tokenId);
        if (exists) {
            throw new Error("The token already minted");
        }

        const tokenIdInt = parseInt(tokenId);
        if (isNaN(tokenIdInt)) {
            throw new Error("The token ID must be an integer");
        }

        const nft = {
            tokenId: tokenIdInt,
            tokenURI: tokenURI,
            name: name,
            description: description,
            owner: minter,
        }

        const nftkey = ctx.stub.createCompositeKey(nftPrefix, [tokenId]);
        await ctx.stub.putState(nftkey, Buffer.from(JSON.stringify(nft)));

        const balancekey = ctx.stub.createCompositeKey(balancePrefix, [minter, tokenId,]);
        await ctx.stub.putState(balancekey, Buffer.from("\u0000"));

        const transferEvent = {
            from: "0x0",
            to: minter,
            tokenId: tokenIdInt,
        }

        await ctx.stub.setEvent("Transfer", Buffer.from(JSON.stringify(transferEvent)));

        return JSON.stringify(nft);
    }

    async ClientAccountBalance(ctx) {
        await this.CheckInitialized(ctx);
        const clientID = ctx.clientIdentity.getID();
        return this.BalanceOf(ctx, clientID);
    }


    async SetApprovalForAll(ctx, operator, approved) {
        await this.CheckInitialized(ctx);
        const sender = ctx.clientIdentity.getID();
        const approvalKey = ctx.stub.createCompositeKey(approvalPrefix, [sender, operator]);
        const approval = {
            owner: sender,
            operator: operator,
            approved: approved
        };
        await ctx.stub.putState(approvalKey, Buffer.from(JSON.stringify(approval)));

        ctx.setEvent("ApprovalForAll", Buffer.from(JSON.stringify(approval)));
        return true;
    }

    async Approve(ctx, approved, tokenId) {
        await this.CheckInitialized(ctx);
        const sender = ctx.clientIdentity.getID();
        const nft = await this._readNFT(ctx, tokenId);

        const owner = nft.owner;
        const operatorApproval = await this.IsApprovedForAll(ctx, owner, sender);

        if (owner !== sender && !operatorApproval) {
            throw new Error("You are not authorized to approve this token");
        }

        nft.approved = approved;
        const nftkey = ctx.stub.createCompositeKey(nftPrefix, [tokenId]);
        await ctx.stub.putState(nftkey, Buffer.from(JSON.stringify(nft)));

        const tokenIdInt = parseInt(tokenId);
        const approvalEvent = {
            owner: owner,
            approved: approved,
            tokenId: tokenIdInt
        }

        ctx.setEvent("Approval", Buffer.from(JSON.stringify(approvalEvent)));
        return true;
    }

    async GetApproved(ctx, tokenId) {
        await this.CheckInitialized(ctx);
        const nft = await this._readNFT(ctx, tokenId);
        return nft.approved;
    }

    async IsApprovedForAll(ctx, owner, sender) {
        await this.Initialize(ctx);

        const approvalKey = ctx.stub.createCompositeKey(approvalPrefix, [owner, sender]);
        const approvalBytes = await ctx.stub.getState(approvalKey);

        if (!approvalBytes || approvalBytes.length === 0) {
            return false;
        } else {
            return JSON.parse(approvalBytes.toString());
        }

    }

    async TotalSupply(ctx) {
        await this.CheckInitialized(ctx);
        const iterator = await ctx.stub.getStateByPartialCompositeKey(nftPrefix, []);
        let count = 0;
        let result = await iterator.next();
        while (!result.done) {
            count++;
            result = await iterator.next();
        }
        return count;
    }

    async _nftExists(ctx, tokenId) {
        const nftkey = ctx.stub.createCompositeKey(nftPrefix, [tokenId]);
        const nftBytes = await ctx.stub.getState(nftkey);
        return nftBytes && nftBytes.length > 0;
    }

    async _readNFT(ctx, tokenId) {
        const nftkey = ctx.stub.createCompositeKey(nftPrefix, [tokenId]);
        const nftBytes = await ctx.stub.getState(nftkey);
        if (!nftBytes || nftBytes.length === 0) {
            throw new Error(`The NFT with ID ${tokenId} does not exist`);
        }
        return JSON.parse(nftBytes.toString());
    }

    async Initialize(ctx, name, symbol) {
        // Verifique que el cliente no este autorizado para cambiarlas una vez inicializado sólo para Org1MSP
        const clientMSPID = ctx.clientIdentity.getMSPID();
        if (clientMSPID !== "Org1MSP") {
            throw new Error(
                `client is not authorized to set the name and symbol of the token ${clientMSPID}`
            );
        }

        // Set the name and symbol
        const nameBytes = await ctx.stub.getState(nameKey);
        if (nameBytes && nameBytes.length > 0) {
            throw new Error(
                "The smart contract has been already initialized. You wasn't authorized to change the name and symbol."
            );
        }

        await ctx.stub.putState(nameKey, Buffer.from(name));
        await ctx.stub.putState(symbolKey, Buffer.from(symbol));
        return true;
    }

    async CleanChaincode(ctx) {
        if (ctx.clientIdentity.getMSPID() !== "Org1MSP") {
            throw new Error("You are not authorized to call this function");
        }

        let iterator = await ctx.stub.getStateByPartialCompositeKey(nftPrefix, []);
        let result = await iterator.next();

        while (!result.done) {
            await ctx.stub.deleteState(result.value.key);
            result = await iterator.next();
        }

        iterator = await ctx.stub.getStateByPartialCompositeKey(balancePrefix, []);
        result = await iterator.next();

        while (!result.done) {
            await ctx.stub.deleteState(result.value.key);
            result = await iterator.next();
        }

        iterator = await ctx.stub.getStateByPartialCompositeKey(approvalPrefix, []);
        result = await iterator.next();

        while (!result.done) {
            await ctx.stub.deleteState(result.value.key);
            result = await iterator.next();
        }

        await ctx.stub.deleteState(nameKey);
        await ctx.stub.deleteState(symbolKey);
        return "OK";
    }

    async ClientAccountID(ctx) {
        await this.CheckInitialized(ctx);
        return ctx.clientIdentity.getID();
    }

    async CheckInitialized(ctx) {
        const nameBytes = await ctx.stub.getState(nameKey);

        if (!nameBytes || nameBytes.length === 0) {
            throw new Error("The smart contract has not been initialized");
        }
    }

    async TransferFrom(ctx, from, to, tokenId) {
        log.info(`TransferFrom from:"${from}" to:"${to}" tokenId:"${tokenId}"`);
        await this.CheckInitialized(ctx);
        return true;
    }
}

module.exports = TokenERC721Contract;