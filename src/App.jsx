import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON } from 'react-leaflet'
import { supabase } from './supabaseClient'
import './App.css'

// A small viridis-ish ramp for the price view — matches the colour scale
// used in the original Colab/matplotlib map.
const PRICE_COLOR_STOPS = [
  [0.0, [68, 1, 84]],
  [0.25, [65, 68, 135]],
  [0.5, [42, 120, 142]],
  [0.75, [122, 209, 81]],
  [1.0, [253, 231, 37]],
]

// Diverging red -> grey -> blue for the % change view: red means the
// ward has got cheaper since the baseline year, blue means pricier.
const CHANGE_COLOR_STOPS = [
  [0.0, [178, 24, 43]],
  [0.5, [230, 230, 230]],
  [1.0, [33, 102, 172]],
]

const PAGE_SIZE = 1000

// Supabase's REST API caps a single select at 1000 rows by default.
// ward_prices has tens of thousands of rows, so a plain .select()
// silently truncates to the first page — this is what was causing
// most of the map to be grey. Loop with .range() until a page comes
// back short. `applyFilter`, if given, is called on the query builder
// before each page (e.g. to scope ward_prices to one tenure).
async function fetchAllRows(table, columns, applyFilter) {
  let from = 0
  const allRows = []
  while (true) {
    let query = supabase.from(table).select(columns)
    if (applyFilter) query = applyFilter(query)
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    allRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return allRows
}

function interpolateStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1]
    const [t1, c1] = stops[i]
    if (clamped <= t1) {
      const f = (clamped - t0) / (t1 - t0)
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]))
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]))
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  const last = stops[stops.length - 1][1]
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`
}

const MISSING_COLOR = '#444654' // never had a single sale in the whole dataset

function colorForPrice(value, vmax) {
  if (value == null || Number.isNaN(value)) return MISSING_COLOR
  return interpolateStops(PRICE_COLOR_STOPS, value / vmax)
}

function colorForChange(value, vcap) {
  if (value == null || Number.isNaN(value)) return MISSING_COLOR
  // map [-vcap, +vcap] -> [0, 1]
  return interpolateStops(CHANGE_COLOR_STOPS, (value + vcap) / (2 * vcap))
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0
  const idx = (sortedValues.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedValues[lo]
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo)
}

function formatPrice(value) {
  if (value == null) return 'No data'
  return `£${Math.round(value).toLocaleString('en-GB')}`
}

function formatPct(value) {
  if (value == null) return 'No data'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

// Build a year-by-year series for every ward, forward-filling any year
// that has no actual sales data with the most recent earlier year that
// does. A ward with a single sale in 1995 and nothing again until 2003
// should read as "unchanged" across 1996-2002 on the map, not grey.
// Returns Map(ward_code -> Map(year -> {price, sales, actualYear})).
// A ward's map only has entries from its first-ever actual sale onward;
// years before that stay unset (true "no data"), by design.
function buildFilledSeries(priceRows, years) {
  const rawByWard = new Map()
  for (const row of priceRows) {
    if (!rawByWard.has(row.ward_code)) rawByWard.set(row.ward_code, new Map())
    rawByWard.get(row.ward_code).set(row.year, {
      median_price: row.median_price,
      sales: row.sales,
    })
  }

  const filledByWard = new Map()

  for (const [wardCode, yearMap] of rawByWard) {
    const filled = new Map()
    let lastActual = null // { year, median_price, sales }

    for (const year of years) {
      const actual = yearMap.get(year)
      if (actual) {
        lastActual = { year, ...actual }
        filled.set(year, { price: actual.median_price, sales: actual.sales, actualYear: year })
      } else if (lastActual) {
        filled.set(year, {
          price: lastActual.median_price,
          sales: lastActual.sales,
          actualYear: lastActual.year,
        })
      }
      // else: ward hasn't had its first sale yet, leave unset (true grey)
    }
    filledByWard.set(wardCode, filled)
  }

  return filledByWard
}

// Two thumbs on one track: drag either end to set the baseline or
// compare year. Each <input type="range"> is stacked on top of the
// other with a transparent track — only the thumb itself captures
// clicks (pointer-events scoped to ::-webkit-slider-thumb /
// ::-moz-range-thumb) — so both ends stay independently grabbable
// even when they're close together.
function DualYearSlider({ min, max, low, high, onLowChange, onHighChange }) {
  const pct = (year) => ((year - min) / (max - min)) * 100

  return (
    <div className="dual-slider">
      <div className="dual-slider-track" />
      <div
        className="dual-slider-range"
        style={{ left: `${pct(low)}%`, width: `${pct(high) - pct(low)}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        value={low}
        onChange={(e) => onLowChange(Number(e.target.value))}
        aria-label="Baseline year"
      />
      <input
        type="range"
        min={min}
        max={max}
        value={high}
        onChange={(e) => onHighChange(Number(e.target.value))}
        aria-label="Compare year"
      />
    </div>
  )
}

// A ward's value as of `year`, used both for the year being viewed and
// for whatever year is chosen as the % change baseline. If the ward's
// own series doesn't reach back to `year` (its first sale was later),
// falls back to its earliest available entry instead, and says so via
// usedYear differing from the requested year.
function seriesValueAt(series, year) {
  if (!series) return null
  const atYear = series.get(year)
  if (atYear) return { ...atYear, usedYear: year }
  const firstKey = series.keys().next().value
  if (firstKey == null) return null
  return { ...series.get(firstKey), usedYear: firstKey }
}

const TENURE_LABELS = { ALL: 'All tenures', F: 'Freehold', L: 'Leasehold' }

export default function App() {
  const [boundaries, setBoundaries] = useState(null) // GeoJSON FeatureCollection
  const [years, setYears] = useState([])
  const [selectedYear, setSelectedYear] = useState(null)
  const [baselineYear, setBaselineYear] = useState(null)
  const [mode, setMode] = useState('price') // 'price' | 'change'
  const [opacity, setOpacity] = useState(0.85)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [errorMessage, setErrorMessage] = useState('')

  // ward_prices holds one row per ward/year/tenure now. Rather than pull
  // all three tenures up front (3x the data most people never switch
  // to), fetch 'ALL' first and lazily fetch freehold/leasehold only
  // when picked, caching each by tenure so switching back is instant.
  const [tenure, setTenure] = useState('ALL') // user's current selection
  const [displayTenure, setDisplayTenure] = useState('ALL') // what's rendered
  const [tenureCache, setTenureCache] = useState({}) // { ALL: filledByWard, F: ..., L: ... }
  const [tenureLoading, setTenureLoading] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const [boundaryRows, priceRows] = await Promise.all([
          fetchAllRows('ward_boundaries_geojson', 'ward_code, name, geojson'),
          fetchAllRows('ward_prices', 'ward_code, year, median_price, sales', (q) =>
            q.eq('tenure', 'ALL')
          ),
        ])

        const features = boundaryRows.map((row) => ({
          type: 'Feature',
          geometry: row.geojson,
          properties: { ward_code: row.ward_code, name: row.name },
        }))

        const sortedYears = Array.from(new Set(priceRows.map((r) => r.year))).sort(
          (a, b) => a - b
        )

        setBoundaries({ type: 'FeatureCollection', features })
        setTenureCache({ ALL: buildFilledSeries(priceRows, sortedYears) })
        setYears(sortedYears)
        setSelectedYear(sortedYears[0]) // start at the earliest year, e.g. 1995
        setBaselineYear(sortedYears[0])
        setStatus('ready')
      } catch (err) {
        console.error(err)
        setErrorMessage(err.message ?? String(err))
        setStatus('error')
      }
    }
    load()
  }, [])

  // Fetch a tenure's price rows the first time it's selected.
  useEffect(() => {
    if (status !== 'ready') return
    if (tenureCache[tenure]) {
      setDisplayTenure(tenure)
      return
    }
    let cancelled = false
    setTenureLoading(true)
    fetchAllRows('ward_prices', 'ward_code, year, median_price, sales', (q) =>
      q.eq('tenure', tenure)
    )
      .then((rows) => {
        if (cancelled) return
        setTenureCache((prev) => ({ ...prev, [tenure]: buildFilledSeries(rows, years) }))
        setDisplayTenure(tenure)
      })
      .catch((err) => {
        if (cancelled) return
        console.error(err)
        setErrorMessage(err.message ?? String(err))
        setTenure((current) => (current === tenure ? displayTenure : current))
      })
      .finally(() => {
        if (!cancelled) setTenureLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tenure, status])

  const filledByWard = tenureCache[displayTenure] ?? null

  function handleYearChange(nextYear) {
    setSelectedYear(nextYear)
    // baseline can't sit after the year being viewed
    setBaselineYear((b) => (b != null && b > nextYear ? nextYear : b))
  }

  function handleBaselineChange(nextBaseline) {
    setBaselineYear(nextBaseline)
    setSelectedYear((y) => (y != null && y < nextBaseline ? nextBaseline : y))
  }

  // Per-ward value for the selected year, in the current mode.
  const yearData = useMemo(() => {
    if (!filledByWard || selectedYear == null) return null
    const map = new Map()
    for (const [wardCode, series] of filledByWard) {
      const current = seriesValueAt(series, selectedYear)
      if (!current) continue
      if (mode === 'price') {
        map.set(wardCode, {
          value: current.price,
          sales: current.sales,
          actualYear: current.actualYear,
        })
      } else {
        const base = seriesValueAt(series, baselineYear)
        const pctChange =
          base && base.price ? ((current.price - base.price) / base.price) * 100 : null
        map.set(wardCode, {
          value: pctChange,
          sales: current.sales,
          actualYear: current.actualYear,
          baselineUsedYear: base?.usedYear,
        })
      }
    }
    return map
  }, [filledByWard, selectedYear, baselineYear, mode])

  const scaleBound = useMemo(() => {
    if (!yearData) return 1
    const values = Array.from(yearData.values())
      .map((v) => v.value)
      .filter((v) => v != null)
    if (values.length === 0) return 1
    if (mode === 'price') {
      return percentile([...values].sort((a, b) => a - b), 0.95) || 1
    }
    // diverging scale: symmetric cap from the 95th percentile of |change|,
    // with a floor so a single quiet year doesn't zoom the scale in to nothing
    const absSorted = values.map((v) => Math.abs(v)).sort((a, b) => a - b)
    return Math.max(percentile(absSorted, 0.95), 10)
  }, [yearData, mode])

  const enrichedData = useMemo(() => {
    if (!boundaries || !yearData) return boundaries
    return {
      ...boundaries,
      features: boundaries.features.map((f) => {
        const entry = yearData.get(f.properties.ward_code)
        return {
          ...f,
          properties: { ...f.properties, ...entry },
        }
      }),
    }
  }, [boundaries, yearData])

  function styleFeature(feature) {
    const { value } = feature.properties
    const fillColor =
      mode === 'price' ? colorForPrice(value, scaleBound) : colorForChange(value, scaleBound)
    return { fillColor, fillOpacity: opacity, color: 'white', weight: 0.6 }
  }

  function onEachFeature(feature, layer) {
    const { name, value, sales, actualYear, baselineUsedYear } = feature.properties
    if (value == null) {
      layer.bindTooltip(`<strong>${name}</strong><br/>No sales on record`, { sticky: true })
      return
    }
    const carriedNote =
      actualYear != null && actualYear !== selectedYear
        ? `<br/><em>price carried forward from ${actualYear}</em>`
        : ''
    const baselineNote =
      mode === 'change' && baselineUsedYear != null && baselineUsedYear !== baselineYear
        ? `<br/><em>baseline: ward's first sale, ${baselineUsedYear}</em>`
        : ''
    const line =
      mode === 'price'
        ? `${formatPrice(value)} median`
        : `${formatPct(value)} since ${baselineYear}`
    layer.bindTooltip(
      `<strong>${name}</strong><br/>${line}<br/>${sales} sale${sales === 1 ? '' : 's'}${carriedNote}${baselineNote}`,
      { sticky: true }
    )
  }

  if (status === 'loading') {
    return <div className="status-message">Loading ward data…</div>
  }

  if (status === 'error') {
    return (
      <div className="status-message status-error">
        Couldn't load data from Supabase: {errorMessage}
      </div>
    )
  }

  const tenureNote = tenure !== 'ALL' ? ` (${TENURE_LABELS[tenure].toLowerCase()})` : ''
  const subtitle =
    mode === 'price'
      ? `Median house price by ward — ${selectedYear}${tenureNote}`
      : `% change in median price, ${baselineYear} → ${selectedYear}${tenureNote}`

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-row">
          <div>
            <h1>London House Prices</h1>
            <p>{subtitle}</p>
          </div>
          <div className="mode-toggle">
            <button
              className={mode === 'price' ? 'active' : ''}
              onClick={() => setMode('price')}
            >
              Price
            </button>
            <button
              className={mode === 'change' ? 'active' : ''}
              onClick={() => setMode('change')}
            >
              % change
            </button>
          </div>
        </div>

        <div className="app-header-row">
          <div className="tenure-toggle">
            {Object.entries(TENURE_LABELS).map(([key, label]) => (
              <button
                key={key}
                className={tenure === key ? 'active' : ''}
                onClick={() => setTenure(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tenureLoading && <span className="tenure-loading">Loading…</span>}
        </div>
      </header>

      <div className="map-wrapper">
        <MapContainer center={[51.509, -0.118]} zoom={10} scrollWheelZoom className="map">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Contains OS data &copy; Crown copyright and database right 2026'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {enrichedData && (
            <GeoJSON
              key={`${mode}-${selectedYear}-${baselineYear}-${displayTenure}`}
              data={enrichedData}
              style={styleFeature}
              onEachFeature={onEachFeature}
            />
          )}
        </MapContainer>

        <div className="legend">
          <div
            className="legend-gradient"
            style={{
              background: `linear-gradient(to right, ${(mode === 'price'
                ? PRICE_COLOR_STOPS
                : CHANGE_COLOR_STOPS
              )
                .map(([, [r, g, b]]) => `rgb(${r},${g},${b})`)
                .join(', ')})`,
            }}
          />
          <div className="legend-labels">
            {mode === 'price' ? (
              <>
                <span>£0</span>
                <span>{formatPrice(scaleBound)}+</span>
              </>
            ) : (
              <>
                <span>-{scaleBound.toFixed(0)}%</span>
                <span>0%</span>
                <span>+{scaleBound.toFixed(0)}%</span>
              </>
            )}
          </div>
        </div>

        <div className="opacity-control" title="Ward fill opacity">
          <span className="opacity-value">{Math.round(opacity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            aria-label="Map opacity"
          />
          <span className="opacity-icon">◐</span>
        </div>
      </div>

      <div className="controls">
        {mode === 'change' ? (
          <div className="control-row">
            <label>Baseline → compare year</label>
            <DualYearSlider
              min={years[0]}
              max={years[years.length - 1]}
              low={baselineYear ?? years[0]}
              high={selectedYear ?? years[years.length - 1]}
              onLowChange={handleBaselineChange}
              onHighChange={handleYearChange}
            />
            <div className="control-row-labels">
              <span>{years[0]}</span>
              <strong>
                {baselineYear} → {selectedYear}
              </strong>
              <span>{years[years.length - 1]}</span>
            </div>
          </div>
        ) : (
          <div className="control-row">
            <label>Year</label>
            <input
              type="range"
              min={years[0]}
              max={years[years.length - 1]}
              value={selectedYear ?? years[0]}
              onChange={(e) => handleYearChange(Number(e.target.value))}
            />
            <div className="control-row-labels">
              <span>{years[0]}</span>
              <strong>{selectedYear}</strong>
              <span>{years[years.length - 1]}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
