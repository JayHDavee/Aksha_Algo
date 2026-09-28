import {
  getIsPointInsidePolygon,
  validatePolygon,
  getPolygonBounds,
  getPolygonArea,
  arePointsInsidePolygon,
} from "../../utils/getInsidePolygon";

describe("getInsidePolygon utils", () => {
  describe("getIsPointInsidePolygon", () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];

    it("should return true for point inside polygon", () => {
      expect(getIsPointInsidePolygon([5, 5], square)).toBe(true);
    });

    it("should return false for point outside polygon", () => {
      expect(getIsPointInsidePolygon([15, 5], square)).toBe(false);
    });

    it("should throw error for invalid point", () => {
      expect(() => getIsPointInsidePolygon([5] as any, square)).toThrow();
    });

    it("should throw error for invalid polygon", () => {
      expect(() => getIsPointInsidePolygon([5, 5], [[0, 0], [1, 1]] as any)).toThrow();
    });
  });

  describe("validatePolygon", () => {
    it("should validate a correct polygon", () => {
      const polygon: [number, number][] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ];
      expect(validatePolygon(polygon).isValid).toBe(true);
    });

    it("should invalidate polygon with less than 3 vertices", () => {
      const polygon: [number, number][] = [
        [0, 0],
        [10, 0],
      ];
      expect(validatePolygon(polygon).isValid).toBe(false);
    });

    it("should invalidate polygon with invalid vertex", () => {
      const polygon: any = [
        [0, 0],
        [10, 0],
        [10, "a"],
      ];
      expect(validatePolygon(polygon).isValid).toBe(false);
    });
  });

  describe("getPolygonBounds", () => {
    it("should calculate correct bounds", () => {
      const polygon: [number, number][] = [
        [10, 20],
        [50, 10],
        [80, 40],
        [30, 60],
      ];
      const bounds = getPolygonBounds(polygon);
      expect(bounds.minX).toBe(10);
      expect(bounds.maxX).toBe(80);
      expect(bounds.minY).toBe(10);
      expect(bounds.maxY).toBe(60);
      expect(bounds.width).toBe(70);
      expect(bounds.height).toBe(50);
    });

    it("should throw error for invalid polygon", () => {
      expect(() => getPolygonBounds([[0, 0], [1, 1]] as any)).toThrow();
    });
  });

  describe("getPolygonArea", () => {
    it("should calculate correct area", () => {
      const rectangle: [number, number][] = [
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ];
      expect(getPolygonArea(rectangle)).toBe(50);
    });

    it("should throw error for invalid polygon", () => {
      expect(() => getPolygonArea([[0, 0], [1, 1]] as any)).toThrow();
    });
  });

  describe("arePointsInsidePolygon", () => {
    it("should return correct array of booleans", () => {
      const polygon: [number, number][] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ];
      const points: [number, number][] = [
        [5, 5],
        [15, 5],
        [7, 7],
      ];
      const results = arePointsInsidePolygon(points, polygon);
      expect(results).toEqual([true, false, true]);
    });

    it("should throw error for invalid points array", () => {
      expect(() => arePointsInsidePolygon(null as any, [] as any)).toThrow();
    });
  });
});
