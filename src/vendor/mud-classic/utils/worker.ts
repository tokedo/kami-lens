/**
 * kami-lens vendored dependency (MIT, compatible with this repo's AGPL-3.0).
 * package:   @mud-classic/utils@0.0.3 — the exact artifact the upstream client
 *            resolves (integrity matches upstream pnpm-lock.yaml at the pin).
 * source:    src/worker.ts, recovered from the published artifact's source maps.
 * copyright: (c) 2022-present Lattice Labs Ltd. (MIT License)
 * changes:   partial vendor — only the DoWork interface. The module's
 *            fromWorker/runWorker are browser web-worker plumbing, replaced by
 *            the in-process sync worker (DESIGN §4.1 swap point 2).
 */

import { Observable } from "rxjs";

export interface DoWork<In, Out> {
  work(input$: Observable<In>): Observable<Out>;
}
