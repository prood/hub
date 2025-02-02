import { EventResponse, EventType, FarcasterNetwork } from '@farcaster/flatbuffers';
import { Factories } from '@farcaster/utils';
import { ClientReadableStream } from '@grpc/grpc-js';
import IdRegistryEventModel from '~/flatbuffers/models/idRegistryEventModel';
import MessageModel from '~/flatbuffers/models/messageModel';
import NameRegistryEventModel from '~/flatbuffers/models/nameRegistryEventModel';
import { CastAddModel, SignerAddModel } from '~/flatbuffers/models/types';
import SyncEngine from '~/network/sync/syncEngine';
import HubRpcClient from '~/rpc/client';
import Server from '~/rpc/server';
import { jestRocksDB } from '~/storage/db/jestUtils';
import Engine from '~/storage/engine';
import { MockHub } from '~/test/mocks';
import { sleep } from '~/utils/crypto';
import { addressInfoFromParts } from '~/utils/p2p';

const db = jestRocksDB('flatbuffers.rpc.eventService.test');
const engine = new Engine(db, FarcasterNetwork.Testnet);
const hub = new MockHub(db, engine);

let server: Server;
let client: HubRpcClient;

beforeAll(async () => {
  server = new Server(hub, engine, new SyncEngine(engine));
  const port = await server.start();
  client = new HubRpcClient(addressInfoFromParts('127.0.0.1', port)._unsafeUnwrap());
});

afterAll(async () => {
  client.close();
  await server.stop();
});

const fid = Factories.FID.build();
const fname = Factories.Fname.build();
const ethSigner = Factories.Eip712Signer.build();
const signer = Factories.Ed25519Signer.build();
let custodyEvent: IdRegistryEventModel;
let nameRegistryEvent: NameRegistryEventModel;
let signerAdd: SignerAddModel;
let castAdd: CastAddModel;

beforeAll(async () => {
  custodyEvent = new IdRegistryEventModel(
    await Factories.IdRegistryEvent.create({ to: Array.from(ethSigner.signerKey), fid: Array.from(fid) })
  );
  nameRegistryEvent = new NameRegistryEventModel(
    await Factories.NameRegistryEvent.create({ to: Array.from(ethSigner.signerKey), fname: Array.from(fname) })
  );

  const signerAddData = await Factories.SignerAddData.create({
    body: Factories.SignerBody.build({ signer: Array.from(signer.signerKey) }),
    fid: Array.from(fid),
  });
  signerAdd = new MessageModel(
    await Factories.Message.create({ data: Array.from(signerAddData.bb?.bytes() ?? []) }, { transient: { ethSigner } })
  ) as SignerAddModel;

  const castAddData = await Factories.CastAddData.create({
    fid: Array.from(fid),
  });
  castAdd = new MessageModel(
    await Factories.Message.create({ data: Array.from(castAddData.bb?.bytes() ?? []) }, { transient: { signer } })
  ) as CastAddModel;
});

describe('subscribe', () => {
  const setupSubscription = (eventTypes?: EventType[]) => {
    let stream: ClientReadableStream<EventResponse> | undefined;
    const events: [EventType, MessageModel | IdRegistryEventModel | NameRegistryEventModel][] = [];

    beforeEach(async () => {
      stream = (await client.subscribe(eventTypes))._unsafeUnwrap();
      stream.on('data', (response: EventResponse) => {
        if (
          response.type() === EventType.MergeMessage ||
          response.type() === EventType.PruneMessage ||
          response.type() === EventType.RevokeMessage
        ) {
          events.push([response.type(), MessageModel.from(response.bytesArray() ?? new Uint8Array())]);
        } else if (response.type() === EventType.MergeIdRegistryEvent) {
          events.push([response.type(), IdRegistryEventModel.from(response.bytesArray() ?? new Uint8Array())]);
        } else if (response.type() === EventType.MergeNameRegistryEvent) {
          events.push([response.type(), NameRegistryEventModel.from(response.bytesArray() ?? new Uint8Array())]);
        }
      });
    });

    afterEach(async () => {
      await stream?.cancel();
    });

    return { stream, events };
  };

  describe('without type filters', () => {
    const { events } = setupSubscription();

    test('emits event', async () => {
      await engine.mergeIdRegistryEvent(custodyEvent);
      await engine.mergeMessage(signerAdd);
      await engine.mergeMessage(castAdd);
      await sleep(1_000); // Wait for server to send events over stream
      expect(events).toEqual([
        [EventType.MergeIdRegistryEvent, custodyEvent],
        [EventType.MergeMessage, signerAdd],
        [EventType.MergeMessage, castAdd],
      ]);
    });
  });

  describe('with one type filter', () => {
    const { events } = setupSubscription([EventType.MergeMessage]);

    test('emits event', async () => {
      await engine.mergeIdRegistryEvent(custodyEvent);
      await engine.mergeNameRegistryEvent(nameRegistryEvent);
      await engine.mergeMessage(signerAdd);
      await engine.mergeMessage(castAdd);
      await sleep(1_000); // Wait for server to send events over stream
      expect(events).toEqual([
        [EventType.MergeMessage, signerAdd],
        [EventType.MergeMessage, castAdd],
      ]);
    });
  });

  describe('with multiple type filters', () => {
    const { events } = setupSubscription([
      EventType.MergeMessage,
      EventType.MergeNameRegistryEvent,
      EventType.MergeIdRegistryEvent,
    ]);

    test('emits event', async () => {
      await engine.mergeIdRegistryEvent(custodyEvent);
      await engine.mergeNameRegistryEvent(nameRegistryEvent);
      await engine.mergeMessage(signerAdd);
      await engine.mergeMessage(castAdd);
      await sleep(1_000); // Wait for server to send events over stream
      expect(events).toEqual([
        [EventType.MergeIdRegistryEvent, custodyEvent],
        [EventType.MergeNameRegistryEvent, nameRegistryEvent],
        [EventType.MergeMessage, signerAdd],
        [EventType.MergeMessage, castAdd],
      ]);
    });
  });
});
