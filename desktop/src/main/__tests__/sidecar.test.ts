import { describe, expect, it } from 'vitest'
import { parseReadyMarker } from '../sidecar'

describe('parseReadyMarker', () => {
  it('extracts port and pid', () => {
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=54321 pid=999')).toEqual({
      port: 54321,
      pid: 999,
    })
  })
  it('returns null for non-marker lines', () => {
    expect(parseReadyMarker('some other log line')).toBeNull()
  })
  it('returns null when port is invalid', () => {
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=abc pid=1')).toBeNull()
  })
  it('returns null when port is out of range', () => {
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=0 pid=1')).toBeNull()
    expect(parseReadyMarker('DOUYIN_SIDECAR_READY port=70000 pid=1')).toBeNull()
  })
})
