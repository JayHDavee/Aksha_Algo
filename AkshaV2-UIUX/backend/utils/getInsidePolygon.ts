/**
 * Polygon Geometry Utility Functions
 * 
 * This module provides geometric utility functions for polygon operations
 * used in the Aksha surveillance system. It includes:
 * - Point-in-polygon detection for surveillance zones
 * - Geometric calculations for camera coverage areas
 * - Spatial analysis for alert triggering
 * 
 * The module implements the ray casting algorithm for reliable point-in-polygon
 * detection, which is essential for determining if detected objects or events
 * occur within defined surveillance zones.
 */

/**
 * Interface for a 2D point coordinate
 */
interface IPoint {
  x: number;
  y: number;
}

/**
 * Type definition for point as array [x, y]
 */
type PointArray = [number, number];

/**
 * Interface for polygon validation result
 */
interface IPolygonValidation {
  isValid: boolean;
  error?: string;
  minVertices?: number;
}

/**
 * Interface for polygon bounds
 */
interface IPolygonBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Determine if a point is inside a polygon using the ray casting algorithm
 * 
 * This function implements the ray casting algorithm (also known as the even-odd rule)
 * to determine if a given point lies inside a polygon. The algorithm works by casting
 * a ray from the point to infinity and counting how many times it intersects with
 * the polygon edges. If the count is odd, the point is inside; if even, it's outside.
 * 
 * This is particularly useful in surveillance systems for:
 * - Determining if detected objects are within monitored zones
 * - Triggering alerts based on spatial boundaries
 * - Filtering events based on geographic regions of interest
 * 
 * @param {PointArray} point - The point to test as [x, y] coordinates
 * @param {PointArray[]} vs - Array of polygon vertices as [[x1, y1], [x2, y2], ...]
 * @returns {boolean} True if point is inside polygon, false otherwise
 * 
 * @example
 * // Define a rectangular surveillance zone
 * const surveillanceZone = [
 *   [0, 0],   // bottom-left
 *   [100, 0], // bottom-right
 *   [100, 50], // top-right
 *   [0, 50]   // top-left
 * ];
 * 
 * // Check if detected object is within zone
 * const objectPosition = [50, 25];
 * const isInZone = getIsPointInsidePolygon(objectPosition, surveillanceZone);
 * console.log(isInZone); // Output: true
 * 
 * @example
 * // Complex polygon for irregular surveillance area
 * const irregularZone = [
 *   [10, 10], [50, 5], [80, 30], [70, 60], [30, 55], [5, 35]
 * ];
 * 
 * const suspiciousActivity = [40, 30];
 * if (getIsPointInsidePolygon(suspiciousActivity, irregularZone)) {
 *   console.log('Alert: Activity detected in monitored zone');
 * }
 * 
 * @throws {Error} If point or polygon vertices are invalid
 */
export const getIsPointInsidePolygon = (point: PointArray, vs: PointArray[]): boolean => {
  try {
    // Validate input parameters
    if (!point || point.length !== 2) {
      throw new Error('Point must be an array with exactly 2 coordinates [x, y]');
    }

    if (!vs || vs.length < 3) {
      throw new Error('Polygon must have at least 3 vertices');
    }

    // Validate that all vertices are valid coordinate pairs
    for (let i = 0; i < vs.length; i++) {
      if (!vs[i] || vs[i].length !== 2 || typeof vs[i][0] !== 'number' || typeof vs[i][1] !== 'number') {
        throw new Error(`Invalid vertex at index ${i}: must be [x, y] with numeric coordinates`);
      }
    }

    // Extract point coordinates
    const x: number = point[0];
    const y: number = point[1];

    // Validate point coordinates
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error('Point coordinates must be numeric values');
    }

    // Ray casting algorithm implementation
    let inside: boolean = false;
    
    // Iterate through each edge of the polygon
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      // Current vertex coordinates
      const xi: number = vs[i][0];
      const yi: number = vs[i][1];
      
      // Previous vertex coordinates (forms an edge with current vertex)
      const xj: number = vs[j][0];
      const yj: number = vs[j][1];

      // Check if ray from point intersects with current edge
      // The ray is cast horizontally to the right from the test point
      const intersect: boolean = 
        yi > y !== yj > y && // Edge crosses the horizontal line through the point
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi; // Point is to the left of intersection

      // Toggle inside/outside status for each intersection
      if (intersect) {
        inside = !inside;
      }
    }

    return inside;
  } catch (error: any) {
    console.error('Error in point-in-polygon calculation:', error.message);
    throw new Error(`Point-in-polygon calculation failed: ${error.message}`);
  }
};

/**
 * Validate if a polygon is properly formed
 * 
 * @param {PointArray[]} vertices - Array of polygon vertices
 * @returns {IPolygonValidation} Validation result with error details
 * 
 * @example
 * const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
 * const validation = validatePolygon(polygon);
 * if (validation.isValid) {
 *   console.log('Polygon is valid');
 * } else {
 *   console.error('Invalid polygon:', validation.error);
 * }
 */
export const validatePolygon = (vertices: PointArray[]): IPolygonValidation => {
  try {
    if (!vertices || !Array.isArray(vertices)) {
      return { isValid: false, error: 'Vertices must be an array' };
    }

    if (vertices.length < 3) {
      return { 
        isValid: false, 
        error: 'Polygon must have at least 3 vertices',
        minVertices: 3
      };
    }

    // Check each vertex
    for (let i = 0; i < vertices.length; i++) {
      const vertex = vertices[i];
      if (!vertex || vertex.length !== 2) {
        return { 
          isValid: false, 
          error: `Vertex at index ${i} must be an array with 2 coordinates` 
        };
      }

      if (typeof vertex[0] !== 'number' || typeof vertex[1] !== 'number') {
        return { 
          isValid: false, 
          error: `Vertex at index ${i} must have numeric coordinates` 
        };
      }

      if (!isFinite(vertex[0]) || !isFinite(vertex[1])) {
        return { 
          isValid: false, 
          error: `Vertex at index ${i} contains invalid numeric values` 
        };
      }
    }

    return { isValid: true };
  } catch (error: any) {
    return { 
      isValid: false, 
      error: `Polygon validation error: ${error.message}` 
    };
  }
};

/**
 * Calculate the bounding box of a polygon
 * 
 * @param {PointArray[]} vertices - Array of polygon vertices
 * @returns {IPolygonBounds} Bounding box coordinates and dimensions
 * 
 * @example
 * const polygon = [[10, 20], [50, 10], [80, 40], [30, 60]];
 * const bounds = getPolygonBounds(polygon);
 * console.log(`Width: ${bounds.width}, Height: ${bounds.height}`);
 */
export const getPolygonBounds = (vertices: PointArray[]): IPolygonBounds => {
  try {
    const validation = validatePolygon(vertices);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }

    let minX = vertices[0][0];
    let maxX = vertices[0][0];
    let minY = vertices[0][1];
    let maxY = vertices[0][1];

    for (const vertex of vertices) {
      minX = Math.min(minX, vertex[0]);
      maxX = Math.max(maxX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      maxY = Math.max(maxY, vertex[1]);
    }

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY
    };
  } catch (error: any) {
    console.error('Error calculating polygon bounds:', error.message);
    throw new Error(`Failed to calculate polygon bounds: ${error.message}`);
  }
};

/**
 * Calculate the area of a polygon using the shoelace formula
 * 
 * @param {PointArray[]} vertices - Array of polygon vertices
 * @returns {number} Area of the polygon
 * 
 * @example
 * const rectangle = [[0, 0], [10, 0], [10, 5], [0, 5]];
 * const area = getPolygonArea(rectangle);
 * console.log(area); // Output: 50
 */
export const getPolygonArea = (vertices: PointArray[]): number => {
  try {
    const validation = validatePolygon(vertices);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }

    let area = 0;
    const n = vertices.length;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += vertices[i][0] * vertices[j][1];
      area -= vertices[j][0] * vertices[i][1];
    }

    return Math.abs(area) / 2;
  } catch (error: any) {
    console.error('Error calculating polygon area:', error.message);
    throw new Error(`Failed to calculate polygon area: ${error.message}`);
  }
};

/**
 * Check if multiple points are inside a polygon (batch operation)
 * 
 * @param {PointArray[]} points - Array of points to test
 * @param {PointArray[]} polygon - Polygon vertices
 * @returns {boolean[]} Array of boolean results for each point
 * 
 * @example
 * const points = [[25, 25], [75, 75], [150, 150]];
 * const zone = [[0, 0], [100, 0], [100, 100], [0, 100]];
 * const results = arePointsInsidePolygon(points, zone);
 * console.log(results); // Output: [true, true, false]
 */
export const arePointsInsidePolygon = (points: PointArray[], polygon: PointArray[]): boolean[] => {
  try {
    if (!points || !Array.isArray(points)) {
      throw new Error('Points must be an array');
    }

    return points.map(point => getIsPointInsidePolygon(point, polygon));
  } catch (error: any) {
    console.error('Error in batch point-in-polygon calculation:', error.message);
    throw new Error(`Batch point-in-polygon calculation failed: ${error.message}`);
  }
};
