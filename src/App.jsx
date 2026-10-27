import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON, Tooltip } from 'react-leaflet'
import { supabase } from './supabaseClient'
import './App.css'

// A small viridis-ish ramp — matches the colour scale used in the
// original Colab/matplotlib map, so the two stay visually consistent.
const COLOR_STOPS = [
  [0.0, [68, 1, 84]],
  [0.25, [65, 68, 135]],
  [0.5, [42, 120, 142]],
  [0.75, [122, 209, 81]],
  [1.0, [253, 231, 37]],
]

function colorForValue(value, vmax) {
  if (value == null || Number.isNaN(value)) return '#d3d3d3' // missing data, grey
  const t = Math.max(0, Math.min(1, value / vmax))
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t0, c0] = COLOR_STOPS[i - 1]
    const [t1, c1] = COLOR_STOPS[i]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0)
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]))
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]))
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1][1]
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`
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

export default function App() {
  const [boundaries, setBoundaries] = useState(null) // GeoJSON FeatureCollection
  const [pricesByYear, setPricesByYear] = useState(null) // { [year]: Map(ward_code -> {median_price, sales}) }
  const [years, setYears] = useState([])
  const [selectedYear, setSelectedYear] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [boundaryRes, priceRes] = await Promise.all([
          supabase.from('ward_boundaries_geojson').select('ward_code, name, geojson'),
          supabase.from('ward_prices').select('ward_code, year, median_price, sales'),
        ])

        if (boundaryRes.error) throw boundaryRes.error
        if (priceRes.error) throw priceRes.error

        const features = boundaryRes.data.map((row) => ({
          type: 'Feature',
          geometry: row.geojson,
          properties: { ward_code: row.ward_code, name: row.name },
        }))

        const byYear = {}
        const yearSet = new Set()
        for (const row of priceRes.data) {
          yearSet.add(row.year)
          if (!byYear[row.year]) byYear[row.year] = new Map()
          byYear[row.year].set(row.ward_code, {
            median_price: row.median_price,
            sales: row.sales,
          })
        }

        const sortedYears = Array.from(yearSet).sort((a, b) => a - b)

        setBoundaries({ type: 'FeatureCollection', features })
        setPricesByYear(byYear)
        setYears(sortedYears)
        setSelectedYear(sortedYears[sortedYears.length - 1])
        setStatus('ready')
      } catch (err) {
        console.error(err)
        setErrorMessage(err.message ?? String(err))
        setStatus('error')
      }
    }
    load()
  }, [])

  const yearPrices = selectedYear != null ? pricesByYear?.[selectedYear] : null

  const vmax = useMemo(() => {
    if (!yearPrices) return 1
    const values = Array.from(yearPrices.values())
      .map((v) => v.median_price)
      .sort((a, b) => a - b)
    return percentile(values, 0.95) || 1
  }, [yearPrices])

  const enrichedData = useMemo(() => {
    if (!boundaries || !yearPrices) return boundaries
    return {
      ...boundaries,
      features: boundaries.features.map((f) => {
        const entry = yearPrices.get(f.properties.ward_code)
        return {
          ...f,
          properties: {
            ...f.properties,
            median_price: entry?.median_price ?? null,
            sales: entry?.sales ?? null,
          },
        }
      }),
    }
  }, [boundaries, yearPrices])

  function styleFeature(feature) {
    return {
      fillColor: colorForValue(feature.properties.median_price, vmax),
      fillOpacity: 0.85,
      color: 'white',
      weight: 0.6,
    }
  }

  function onEachFeature(feature, layer) {
    const { name, median_price, sales } = feature.properties
    const label =
      median_price != null
        ? `<strong>${name}</strong><br/>${formatPrice(median_price)} median<br/>${sales} sale${sales === 1 ? '' : 's'}`
        : `<strong>${name}</strong><br/>No data for ${selectedYear}`
    layer.bindTooltip(label, { sticky: true })
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>London Place Change</h1>
        <p>Median house price by ward, {selectedYear}</p>
      </header>

      <div className="map-wrapper">
        <MapContainer
          center={[51.509, -0.118]}
          zoom={10}
          scrollWheelZoom
          className="map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {enrichedData && (
            <GeoJSON
              key={selectedYear}
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
              background: `linear-gradient(to right, ${COLOR_STOPS.map(
                ([, [r, g, b]]) => `rgb(${r},${g},${b})`
              ).join(', ')})`,
            }}
          />
          <div className="legend-labels">
            <span>£0</span>
            <span>{formatPrice(vmax)}+</span>
          </div>
        </div>
      </div>

      <div className="year-control">
        <input
          type="range"
          min={years[0]}
          max={years[years.length - 1]}
          value={selectedYear ?? years[0]}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        />
        <div className="year-control-labels">
          <span>{years[0]}</span>
          <strong>{selectedYear}</strong>
          <span>{years[years.length - 1]}</span>
        </div>
      </div>
    </div>
  )
}
