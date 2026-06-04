import { createStorage, StorageEnum } from '../base/index.js';
import type { BaseStorageType } from '../base/index.js';

interface WolffishConnectionConfig {
  port: number;
}

type WolffishConnectionStorageType = BaseStorageType<WolffishConnectionConfig>;

const storage = createStorage<WolffishConnectionConfig>(
  'wolffish-connection-config',
  { port: 23151 },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

const wolffishConnectionStorage: WolffishConnectionStorageType = {
  ...storage,
};

export { wolffishConnectionStorage };
export type { WolffishConnectionConfig, WolffishConnectionStorageType };
