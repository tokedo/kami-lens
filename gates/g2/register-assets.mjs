// Registers the asset load hook (see asset-loader.mjs) for the G2.a
// upstream runner. Used via NODE_OPTIONS=--import so it composes with tsx.
import { register } from 'node:module';

register(new URL('./asset-loader.mjs', import.meta.url));
