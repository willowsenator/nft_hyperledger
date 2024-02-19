import express from 'express';
import { connect } from '@hyperledger/fabric-gateway';
import type { AddressInfo } from 'net';
import { config, checkConfig } from "./config";
import { Logger } from 'tslog';
import * as yaml from 'yaml';
import { promises as fs } from 'fs';
import * as _ from 'lodash';
import { User } from "fabric-common";
import FabricCAServices from 'fabric-ca-client';
import { newGrpcConnection, newConnectionOptions } from "./utils";

const logger = new Logger({
    name: 'nft-api'
});

const main = async () => {
    checkConfig();
    const networkingConfig = yaml.parse(await fs.readFile(config.networkConfigPath, 'utf8'));
    const orgPeerNames = _.get(networkingConfig, `organizations.${config.mspId}.peers`, []);
    if (!orgPeerNames) {
        throw new Error(`Organization ${config.mspId} has any peers`);
    }

    let peerUrl: string = "";
    let peerCACert: string = "";
    let idx = 0;

    for (const peerName of orgPeerNames) {
        const peer = networkingConfig.peers[peerName];
        if (!peer) {
            throw new Error(`Peer ${peerName} not found`);
        }

        const peerUrlKey = "url";
        const peerCaCert = "tlsCACerts.pem";

        peerUrl = _.get(peer, peerUrlKey).replace('grpcs://', "");
        peerCACert = _.get(peer, peerCaCert);
        idx++;

        if (idx >= 1) {
            break;
        }
    }

    if (!peerUrl || !peerCACert) {
        throw new Error(`Organization ${config.mspId} doesn't have any peers`);
    }

    const ca = networkingConfig.certificateAuthorities[config.caName];
    if (!ca) {
        throw new Error(`CA ${config.caName} not found`);
    }

    const caUrl = ca.url;
    if (!caUrl) {
        throw new Error(`CA ${config.caName} has no url`);
    }

    const fabricCAServices = new FabricCAServices(caUrl, {
        trustedRoots: [ca.tlsCACerts.pem[0]],
        verify: true
    }, ca.caName);

    const identityService = fabricCAServices.newIdentityService();
    const registrarUserResponse = await fabricCAServices.enroll({
        enrollmentID: ca.registrar.enrollId,
        enrollmentSecret: ca.registrar.enrollSecret
    });

    const registrar = User.createUser(
        ca.registrar.enrollId,
        ca.registrar.enrollSecret,
        config.mspId,
        registrarUserResponse.certificate,
        registrarUserResponse.key.toBytes()
    );

    const adminUser = _.get(networkingConfig, `organizations.${config.mspId}.users.${config.hlfUser}`, []);
    const userCert = _.get(adminUser, 'cert.pem');
    const userKey = _.get(adminUser, 'key.pem');

    if (!userCert || !userKey) {
        throw new Error(`User ${config.hlfUser} not found`);
    }

    const grpcConn = await newGrpcConnection(peerUrl, Buffer.from(peerCACert));
    const connectionOptions = await newConnectionOptions(
        grpcConn,
        config.mspId,
        Buffer.from(userCert),
        userKey
    );

    const gateway = connect(connectionOptions);
    const network = gateway.getNetwork(config.channelName);
    const contract = network.getContract(config.chaincodeName);
    const app = express();
    app.use(express.json());
    app.use((_req, _res, _next) => {
        _res.header("Access-Control-Allow-Origin", "*");
        _res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        _next();
    });

    app.get('/ping', async (req, res) => {
        try {
            const responseBuffer = await (req as any).contract.evaluateTransaction('ping');
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (error: any) {
            res.status(400);
            res.send(error.details && error.details.length > 0 ? error.details : error.message);
        }
    });

    const users: { [username: string]: any } = {};
    app.post('/signup', async (req, res) => {
        const { username, password } = req.body;
        let identityFound = null;
        try {
            identityFound = await identityService.getOne(username, registrar);
        } catch (error: any) {
            res.status(400);
            res.send("Identity not found. registering user");
        }
        if (identityFound) {
            res.status(400);
            res.send("Username already taken");
            return;
        }

        fabricCAServices.register({
            enrollmentID: username,
            enrollmentSecret: password,
            affiliation: "",
            attrs: [],
            maxEnrollments: -1
        }, registrar);
        res.send("OK");
    });

    app.post('/login', async (req, res) => {
        const { username, password } = req.body;
        let identityFound = null;
        try {
            identityFound = await identityService.getOne(username, registrar);
        } catch (error: any) {
            res.status(400);
            res.send("Username not found");
        }

        const r = fabricCAServices.enroll({
            enrollmentID: username,
            enrollmentSecret: password
        });

        users[username] = r;
        res.send("OK");

    });

    app.use(async (req, res, next) => {
        (req as any).contract = contract
        try {
            const user = req.headers["x-user"] as string;
            if (user && users[user]) {
                const connectOptions = await newConnectionOptions(
                    grpcConn,
                    config.mspId,
                    Buffer.from(users[user].certificate),
                    users[user].key.toBytes()
                );
                const gateway = connect(connectOptions);
                const network = gateway.getNetwork(config.channelName);
                const contract = network.getContract(config.chaincodeName);
                (req as any).contract = contract;
            }
            next();
        } catch (e) {
            logger.error(e)
            next(e)
        }
    });

    app.post('/id', async (req, res) => {
        try {
            const responseBuffer = await (req as any).contract.evaluateTransaction('ClientAccountID');
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (error: any) {
            res.status(400);
            res.send(error.details && error.details.length > 0 ? error.details : error.message);
        }
    });

    app.post('/evaluate', async (req, res) => {
        try {
            const fcn = req.body.fcn;
            const args = req.body.args;
            const responseBuffer = await (req as any).contract.evaluateTransaction(fcn, ...(args || []));
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (error: any) {
            res.status(400);
            res.send(error.details && error.details.length > 0 ? error.details : error.message);
        }
    });

    app.post('/submit', async (req, res) => {
        try {
            const fcn = req.body.fcn;
            const args = req.body.args;
            const responseBuffer = await (req as any).contract.submitTransaction(fcn, ...(args || []));
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (error: any) {
            res.status(400);
            res.send(error.details && error.details.length > 0 ? error.details : error.message);
        }
    });

    const server = app.listen({
        port: process.env.PORT || 3000,
        host: '0.0.0.0'
    }, () => {
        const address = server.address() as AddressInfo;
        console.log(`Listening on ${address.address}:${address.port}`);
    });
}

main();