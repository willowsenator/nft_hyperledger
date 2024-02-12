const { Contract } = require('fabric-contract-api');

const tslog = require('tslog');
const log = new tslog.Logger({});

class TokenERC721Contract extends Contract {
    async ping(ctx) {
        log.info('ping');
        return 'pong';
    }
}
module.exports = TokenERC721Contract;