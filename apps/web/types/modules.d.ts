declare module 'react-simple-maps' {
  import * as React from 'react';
  
  interface ComposableMapProps {
    projection?: string;
    projectionConfig?: object;
    width?: number;
    height?: number;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }
  
  interface ZoomableGroupProps {
    center?: [number, number];
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    onMoveEnd?: (event: { coordinates: [number, number]; zoom: number }) => void;
    children?: React.ReactNode;
  }
  
  interface GeographiesProps {
    geography: string | object;
    children: (props: { geographies: any[] }) => React.ReactNode;
  }
  
  interface GeographyProps {
    geography: any;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    style?: {
      default?: React.CSSProperties;
      hover?: React.CSSProperties;
      pressed?: React.CSSProperties;
    };
    onClick?: (event: any) => void;
    onMouseEnter?: (event: any) => void;
    onMouseLeave?: (event: any) => void;
  }
  
  export const ComposableMap: React.FC<ComposableMapProps>;
  export const ZoomableGroup: React.FC<ZoomableGroupProps>;
  export const Geographies: React.FC<GeographiesProps>;
  export const Geography: React.FC<GeographyProps>;
}

declare module 'd3-scale' {
  interface ScaleLinear<Output> {
    domain(domain: number[]): ScaleLinear<Output>;
    range(range: Output[]): ScaleLinear<Output>;
    (value: number): Output;
  }
  
  export function scaleLinear<Output = number>(): ScaleLinear<Output>;
}
