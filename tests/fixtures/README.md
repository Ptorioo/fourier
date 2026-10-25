# Archive interoperability fixtures

Generated independently using NumPy 2.5.4, not Fourier's TypeScript encoder.
No Python installation is needed to run these tests.

- `numpy-compressed.npz`: `np.savez_compressed`, float32 stereo input
  `[[0, .25, -.5, 1], [-1, .5, -.25, 0]]`, output = input * .5,
  scalar int64 sample rate 48000. Includes NumPy's ZIP64 local headers.
- `numpy-stored.npz`: `np.savez`, float32 mono first channel of the same input,
  output = input * .5, scalar int32 sample rate 44100.
