import { ConnectOptions, Signer, signers, Identity } from '@hyperledger/fabric-gateway';

import * as grpc from '@grpc/grpc-js';
import * as crypto from 'crypto';

export const newGrpcConnection = async (peerEndpoint: string, tlsRootCert: Buffer): Promise<grpc.Client> => {
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {});
}

export const newConnectionOptions = async (
    client: grpc.Client,
    mspId: string,
    credentials: Uint8Array,
    privateKeyPem: string
): Promise<ConnectOptions> => {
    return {
        client,
        identity: await newIdentity(mspId, credentials),
        signer: await newSigner(privateKeyPem),
        evaluateOptions: () => {
            return { deadline: Date.now() + 5000 }; // 5 seconds
        },
        submitOptions: () => {
            return { deadline: Date.now() + 5000 }; // 5 seconds
        },
        commitStatusOptions: () => {
            return { deadline: Date.now() + 60000 }; // 1 minutes
        },
        endorseOptions: () => {
            return { deadline: Date.now() + 15000 }; // 15 seconds
        }
    }
}

export const newIdentity = async (mspId: string, credentials: Uint8Array): Promise<Identity> => {
    return { mspId, credentials };
}

export const newSigner = async (privateKeyPem: string): Promise<Signer> => {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}