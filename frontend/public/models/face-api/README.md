# face-api.js model weights

The three model files in this directory are the standard pre-trained
weights for the face-api.js models we use. They are loaded by the
browser at runtime when the user enrolls their face or confirms a
payment via Face ID.

| File                                | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `tiny_face_detector_model-*`        | Lightweight face detector (~190 KB).                   |
| `face_landmark_68_tiny_model-*`     | 68-point landmark predictor for face alignment.        |
| `face_recognition_model-*`          | Produces the 128-dim embedding used for matching.      |

## Source

Mirrored from the upstream face-api.js weights directory:

```
https://github.com/justadudewhohacks/face-api.js/tree/master/weights
```

We pin to `face-api.js@0.22.2`. **The `face_recognition_model` weights are
split across two shard files** (shard1 + shard2) — face-api.js's manifest
references both, and the recognition net will throw a tensor-shape error
during conv256_down loading if shard2 is missing. The other two models
are single-shard. To upgrade, bump the dependency in `package.json`,
delete this folder, and re-download with:

```bash
cd frontend/public/models/face-api
for m in tiny_face_detector face_landmark_68_tiny face_recognition; do
  curl -sSL -o "${m}_model-weights_manifest.json" \
    "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/${m}_model-weights_manifest.json"
  curl -sSL -o "${m}_model-shard1" \
    "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/${m}_model-shard1"
done
```

## Runtime loading

`lib/face.ts` calls `faceapi.nets.tinyFaceDetector.loadFromUri('/models/face-api')`
(etc.) — the URL prefix must stay `/models/face-api/`. The manifests
reference their shards by relative filename, so as long as the prefix
stays consistent the browser fetches everything correctly.

## Caching

`next.config.js` sets `Cache-Control: public, max-age=31536000, immutable`
on this path, so returning users don't re-download ~4.4 MB of weights
on every page load. To bust the cache after an upgrade, rename the
directory and update both `next.config.js` and `lib/face.ts`.
