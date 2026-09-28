import React, { useState, useEffect, useRef } from "react";
import { Stage, Layer, Line, Rect } from "react-konva";
import { coordinatesSelected } from "../../global_store/reducers/investigationReducer";
import { useDispatch } from "react-redux";

// The mock is included for context but is not part of the component logic itself.
/*
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));
*/


interface CanvasDraw2Props {
  imageUrl: string;
  setAIPolygen: (points: number[][]) => void;
  styleProperities: {
    width?: number;
    height?: number;
  };
  imagesLength: number;
  isClose: boolean;
}

const CanvasDraw2: React.FC<CanvasDraw2Props> = ({
  imageUrl,
  setAIPolygen,
  styleProperities,
  imagesLength,
  isClose,
}) => {
  const dispatch = useDispatch();

  const [points, setPoints] = useState<number[][]>([]);
  const [curMousePos, setCurMousePos] = useState<[number, number]>([0, 0]);
  const [isMouseOverStartPoint, setIsMouseOverStartPoint] = useState(false);
  const [isFinished, setIsFinished] = useState(false);

  // 1. New: Handle setting the polygon coordinates when the polygon is finished.
  // This is the cleanest way to signal the final result to the parent.
  useEffect(() => {
    if (isFinished) {
      setAIPolygen(points);
      // Ensure the start point is not scaled if we click to finish
      setIsMouseOverStartPoint(false); 
    }
  }, [isFinished, setAIPolygen, points]);


  // 2. Combined Logic for isClose and imagesLength changes/resets.
  // This hook handles external control signals (close, image change).
  useEffect(() => {
    // Logic for when the component is explicitly closed by the parent (or reset state).
    if (isClose) {
      // Clear all state
      setPoints([]);
      setAIPolygen([]); // Inform parent of clear
      setCurMousePos([0, 0]);
      setIsMouseOverStartPoint(false);
      setIsFinished(false);
      
    // The specific condition from the warning: imagesLength > 1 when not closed
    } else if (imagesLength > 1) { 
        // This is the state reset that was causing the loop due to missing dependency logic 
        // in the original third useEffect. 
        setPoints([]);
        setAIPolygen([]);
        setCurMousePos([0, 0]);
        setIsMouseOverStartPoint(false);
        setIsFinished(false);
    } 
    // Removed the problematic else block and the check for isMouseOverStartPoint 
    // which led to continuous updates.
  }, [isClose, imagesLength, setAIPolygen]);
  
  // Clean up initial useEffects that were causing the loop:
  /*
  // Original first useEffect: REMOVED/REPLACED BY NEW EFFECT (1)
  useEffect(() => {
    if (isMouseOverStartPoint) {
      setAIPolygen(points); // Calling setAIPolygen on every mouse over/out update causes a loop
    }
  }, [points, isMouseOverStartPoint]); 

  // Original second useEffect: PARTIALLY COMBINED INTO NEW EFFECT (2)
  useEffect(() => {
    if (isClose) {
      setPoints([]);
      setAIPolygen([]);
    } else {
      // The logic here creates an issue if setAIPolygen is not memoized or if 
      // isMouseOverStartPoint is true, triggering the first hook.
      setAIPolygen(points); 
      setIsMouseOverStartPoint(true);
      setCurMousePos([0, 0]);
      setIsFinished(false);
    }
  }, [isClose]);

  // Original third useEffect: PARTIALLY COMBINED INTO NEW EFFECT (2)
  useEffect(() => {
    if (!isClose && imagesLength > 1) {
      setPoints([]); // This update triggers the hook again because 'points' is a dependency
      setAIPolygen([]); // This update causes the parent to re-render, potentially leading to new props
    }
    if (isMouseOverStartPoint) {
      setAIPolygen(points);
    }
  }, [imagesLength, points, isMouseOverStartPoint]); 
  */


  const getMousePos = (stage: any): [number, number] => {
    const pos = stage.getPointerPosition();
    return pos ? [pos.x, pos.y] : [0, 0];
  };

  const handleClick = (event: any) => {
    const stage = event.target.getStage();
    if (!stage) return;

    const mousePos = getMousePos(stage);
    dispatch(coordinatesSelected(isMouseOverStartPoint));

    if (isFinished) return;

    if (isMouseOverStartPoint && points.length >= 3) {
      // Setting isFinished to true will trigger the new, clean useEffect (1) to call setAIPolygen.
      setIsFinished(true); 
    } else {
      setPoints([...points, mousePos]);
      // For immediate prop update while drawing (optional, but useful for feedback)
      setAIPolygen([...points, mousePos]); 
    }
  };

  const handleMouseMove = (event: any) => {
    const stage = event.target.getStage();
    if (!stage) return;

    const mousePos = getMousePos(stage);
    setCurMousePos(mousePos);
  };

  const handleMouseOverStartPoint = (event: any) => {
    if (isFinished || points.length < 3) return;
    const shape = event.target;
    shape.scale({ x: 2, y: 2 });
    setIsMouseOverStartPoint(true);
  };

  const handleMouseOutStartPoint = (event: any) => {
    const shape = event.target;
    shape.scale({ x: 1, y: 1 });
    setIsMouseOverStartPoint(false);
  };

  const handleDragMovePoint = (event: any) => {
    const index = event.target.index - 1;
    const pos = [event.target.x(), event.target.y()] as [number, number];
    const newPoints = [...points.slice(0, index), pos, ...points.slice(index + 1)];
    setPoints(newPoints);
    
    // Update parent component immediately after a drag move, especially if already finished
    if (isFinished) {
        setAIPolygen(newPoints);
    }
  };

  const flattenedPoints = points
    .concat(isFinished ? [] : [curMousePos])
    .reduce<number[]>((acc, point) => acc.concat(point), []);

  const stageWidth = styleProperities.width || 640;
  const stageHeight = styleProperities.height || 360;

  // Konva's <Stage> is canvas-based and doesn't shrink with its container on
  // its own, so at the stage's native size it can overflow a narrow column
  // (e.g. the modal's right-hand image panel). Scale the whole stage down via
  // a wrapping div sized to the available width — Konva reads the *rendered*
  // (post-transform) bounding rect for pointer position, so click coordinates
  // stay correct at any scale.
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateScale = () => {
      const availableWidth = el.clientWidth;
      if (availableWidth > 0) {
        setScale(Math.min(1, availableWidth / stageWidth));
      }
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageWidth]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: stageHeight * scale }}
    >
      <div
        style={{
          width: stageWidth,
          height: stageHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <Stage
          width={stageWidth}
          height={stageHeight}
          onMouseDown={handleClick}
          onMouseMove={handleMouseMove}
          crossorigin="anonymous"
          style={{
            backgroundImage: `url(${imageUrl})`,
            backgroundSize: `${stageWidth}px ${stageHeight}px`,
            backgroundRepeat: "no-repeat",
            height: stageHeight,
            width: stageWidth,
          }}
        >
          <Layer>
            <Line
              points={flattenedPoints}
              stroke="yellow"
              strokeWidth={3}
              closed={isFinished}
            />
            {points.map((point, index) => {
              const size = 6;
              const x = point[0] - size / 2;
              const y = point[1] - size / 2;

              const startPointProps =
                index === 0
                  ? {
                      hitStrokeWidth: 12,
                      onMouseOver: handleMouseOverStartPoint,
                      onMouseOut: handleMouseOutStartPoint,
                    }
                  : {};

              return (
                <Rect
                  key={index}
                  x={x}
                  y={y}
                  width={size}
                  height={size}
                  fill="white"
                  stroke="yellow"
                  strokeWidth={3}
                  draggable
                  onDragMove={handleDragMovePoint}
                  {...startPointProps}
                />
              );
            })}
          </Layer>
        </Stage>
      </div>
    </div>
  );
};

export default CanvasDraw2;