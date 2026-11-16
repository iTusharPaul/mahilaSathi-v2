import type { ScoredRoute } from '@mahilasathi/shared';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { resolveTheme, useThemeStore } from '@/stores/themeStore';

const KIND_LABEL: Record<string, string> = {
  food: 'Food', shop: 'Shop', pharmacy: 'Pharmacy', fuel: 'Fuel station', hotel: 'Hotel', metro: 'Metro station', bus: 'Bus stop', police: 'Police', hospital: 'Hospital',
};

const KIND_COLOUR: Record<string, string> = {
  metro: '#2f6fd6',
  bus: '#2f6fd6',
  police: '#40234F',
  hospital: '#b82626',
  fuel: '#8a5e1a',
};

function styleFor(theme: 'light' | 'dark', tiles: boolean): StyleSpecification {
  return {
    version: 8,
    sources: tiles
      ? {
          base: {
            type: 'raster',
            // Proxied through our server so the Geoapify key never reaches the browser.
            tiles: [`${window.location.origin}/api/map/tiles/${theme}/{z}/{x}/{y}.png`],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors',
          },
        }
      : {},
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': theme === 'dark' ? '#1b1720' : '#efeaf2' } },
      ...(tiles ? [{ id: 'base', type: 'raster' as const, source: 'base' }] : []),
    ],
  };
}

export type MapRoute = Pick<ScoredRoute, 'id' | 'geometry' | 'places'>;

/** Routes, endpoints and the places that count towards the selected route's score; optionally a live point. */
export function RouteMap({ routes, selectedId, tiles, marker, label = 'Map of route options', onSelect }: { routes: MapRoute[]; selectedId: string | null; tiles: boolean; marker?: [number, number] | null; label?: string; onSelect?: (id: string) => void }) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const preference = useThemeStore((s) => s.preference);
  const theme = resolveTheme(preference);

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({ container: container.current, style: styleFor(theme, tiles), center: [77.209, 28.6139], zoom: 9, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [theme, tiles]);

  useEffect(() => {
    const m = map.current;
    if (!m || routes.length === 0) return;
    const draw = () => {
      const selected = routes.find((r) => r.id === selectedId) ?? routes[0]!;
      const routeData = {
        type: 'FeatureCollection' as const,
        // Selected route last so it draws on top.
        features: [...routes.filter((r) => r.id !== selected.id), selected]
          .map((r) => ({ type: 'Feature' as const, properties: { selected: r.id === selected.id, id: r.id }, geometry: { type: 'LineString' as const, coordinates: r.geometry } })),
      };
      const first = selected.geometry[0]!;
      const last = selected.geometry[selected.geometry.length - 1]!;
      const pointData = {
        type: 'FeatureCollection' as const,
        features: [
          ...selected.places.map((p) => ({
            type: 'Feature' as const,
            properties: {
              colour: p.open === true ? '#347D64' : KIND_COLOUR[p.kind] ?? (p.open === false ? '#9a90a3' : '#c9bfd2'),
              radius: 5,
              info: `${p.name ?? 'Unnamed place'} · ${KIND_LABEL[p.kind] ?? p.kind}${p.open === true ? ' · open when you pass' : p.open === false ? ' · closed when you pass' : ['metro', 'bus', 'police', 'hospital'].includes(p.kind) ? '' : ' · hours unknown'}`,
            },
            geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          })),
          { type: 'Feature' as const, properties: { colour: '#40234F', radius: 8 }, geometry: { type: 'Point' as const, coordinates: first } },
          { type: 'Feature' as const, properties: { colour: '#E77C72', radius: 8 }, geometry: { type: 'Point' as const, coordinates: last } },
          ...(marker ? [{ type: 'Feature' as const, properties: { colour: '#2f6fd6', radius: 9 }, geometry: { type: 'Point' as const, coordinates: marker } }] : []),
        ],
      };
      const routeSource = m.getSource('routes') as GeoJSONSource | undefined;
      if (routeSource) {
        routeSource.setData(routeData);
        (m.getSource('points') as GeoJSONSource).setData(pointData);
      } else {
        m.addSource('routes', { type: 'geojson', data: routeData });
        m.addSource('points', { type: 'geojson', data: pointData });
        m.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'selected'], 9, 6], 'line-opacity': 0.9 } });
        m.addLayer({ id: 'route-line', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['get', 'selected'], '#40234F', '#a99bb5'], 'line-width': ['case', ['get', 'selected'], 5, 3.5] } });
        m.addLayer({ id: 'points', type: 'circle', source: 'points', paint: { 'circle-color': ['get', 'colour'], 'circle-radius': ['get', 'radius'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
        // Interactions: tap a route to select it; tap a place to see what it is and whether it's open.
        m.on('click', 'route-line', (e) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          if (id) onSelectRef.current?.(id);
        });
        m.on('click', 'points', (e) => {
          const f = e.features?.[0];
          const info = f?.properties?.info as string | undefined;
          if (!f || !info || f.geometry.type !== 'Point') return;
          new maplibregl.Popup({ closeButton: true, maxWidth: '240px' }).setLngLat(f.geometry.coordinates as [number, number]).setText(info).addTo(m);
        });
        for (const layer of ['route-line', 'points']) {
          m.on('mouseenter', layer, () => (m.getCanvas().style.cursor = 'pointer'));
          m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''));
        }
      }
      const bounds = new maplibregl.LngLatBounds();
      for (const r of routes) for (const c of r.geometry) bounds.extend(c);
      m.fitBounds(bounds, { padding: 36, maxZoom: 16, duration: 0 });
    };
    if (m.isStyleLoaded()) draw();
    else m.once('load', draw);
  }, [routes, selectedId, theme, tiles, marker]);

  return <div ref={container} className="h-72 w-full overflow-hidden rounded-2xl border border-border/70 sm:h-80" role="img" aria-label={label} />;
}
