import { FarcasterNetwork } from '@farcaster/flatbuffers';
import { Ed25519Signer, Factories } from '@farcaster/utils';
import MessageModel from '~/flatbuffers/models/messageModel';
import { AmpAddModel, CastAddModel } from '~/flatbuffers/models/types';
import { jestRocksDB } from '~/storage/db/jestUtils';
import Engine from '~/storage/engine';
import { seedSigner } from '~/storage/engine/seed';
import { PruneMessagesJobScheduler } from './pruneMessagesJob';

const db = jestRocksDB('jobs.pruneMessagesJob.test');

const engine = new Engine(db, FarcasterNetwork.Testnet);
const scheduler = new PruneMessagesJobScheduler(engine);

// Use farcaster timestamp
const seedMessagesFromTimestamp = async (engine: Engine, fid: Uint8Array, signer: Ed25519Signer, timestamp: number) => {
  const castAddData = await Factories.CastAddData.create({ fid: Array.from(fid), timestamp });
  const castAdd = new MessageModel(
    await Factories.Message.create(
      { data: Array.from(castAddData.bb?.bytes() ?? new Uint8Array()) },
      { transient: { signer } }
    )
  ) as CastAddModel;

  const ampAddData = await Factories.AmpAddData.create({ fid: Array.from(fid), timestamp });
  const ampAdd = new MessageModel(
    await Factories.Message.create(
      { data: Array.from(ampAddData.bb?.bytes() ?? new Uint8Array()) },
      { transient: { signer } }
    )
  ) as AmpAddModel;

  return engine.mergeMessages([castAdd, ampAdd]);
};

let prunedMessages: MessageModel[] = [];

const pruneMessageListener = (message: MessageModel) => {
  prunedMessages.push(message);
};

beforeAll(() => {
  engine.eventHandler.on('pruneMessage', pruneMessageListener);
});

beforeEach(() => {
  prunedMessages = [];
});

afterAll(() => {
  engine.eventHandler.off('pruneMessage', pruneMessageListener);
});

describe('doJobs', () => {
  test('succeeds without fids', async () => {
    const result = await scheduler.doJobs();
    expect(result._unsafeUnwrap()).toEqual(undefined);
  });

  test('prunes messages for all fids', async () => {
    const timestampToPrune = 1; // 1 second after farcaster epoch (1/1/22)

    const fid1 = Factories.FID.build();

    const signer1 = Factories.Ed25519Signer.build();
    await seedSigner(engine, fid1, signer1.signerKey);
    await seedMessagesFromTimestamp(engine, fid1, signer1, timestampToPrune);

    const fid2 = Factories.FID.build();

    const signer2 = Factories.Ed25519Signer.build();
    await seedSigner(engine, fid2, signer2.signerKey);
    await seedMessagesFromTimestamp(engine, fid2, signer2, timestampToPrune);

    for (const fid of [fid1, fid2]) {
      const casts = await engine.getCastsByFid(fid);
      expect(casts._unsafeUnwrap().length).toEqual(1);

      const amps = await engine.getAmpsByFid(fid);
      expect(amps._unsafeUnwrap().length).toEqual(1);
    }

    const result = await scheduler.doJobs();
    expect(result._unsafeUnwrap()).toEqual(undefined);

    for (const fid of [fid1, fid2]) {
      const casts = await engine.getCastsByFid(fid);
      expect(casts._unsafeUnwrap()).toEqual([]);

      const amps = await engine.getAmpsByFid(fid);
      expect(amps._unsafeUnwrap()).toEqual([]);
    }

    expect(prunedMessages.length).toEqual(4);
  });
});
