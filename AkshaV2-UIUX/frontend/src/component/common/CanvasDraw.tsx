import React, { useState, useEffect } from "react";
import { Stage, Layer, Line, Rect, Image } from "react-konva";
import useImage from "use-image";
import { coordinatesSelected } from "../../global_store/reducers/investigationReducer";
import { useDispatch } from "react-redux";

interface CanvasDrawProps {
  imageUrl: string;
  setAIPolygen: (points: number[][]) => void;
  width?: number;
  height?: number;
}

/**
 * CanvasDraw Component
 * 
 * Allows users to draw a polygon on an image by clicking points.
 * Supports dragging points to adjust polygon shape.
 * Dispatches Redux action when coordinates are selected.
 */
const CanvasDraw: React.FC<CanvasDrawProps> = ({ imageUrl, setAIPolygen, width = 640, height = 360 }) => {
  const dispatch = useDispatch();

  // Array of points representing the user's selection
  const [points, setPoints] = useState<number[][]>([]);

  // Current mouse position
  const [curMousePos, setCurMousePos] = useState<number[]>([0, 0]);

  // Whether the mouse is over the start point
  const [isMouseOverStartPoint, setIsMouseOverStartPoint] = useState(false);

  // Whether the selection is finished
  const [isFinished, setIsFinished] = useState(false);

  // Image render function using useImage hook
  const LionImage = () => {
    const [image] = useImage(imageUrl);
    return <Image image={image} x={0} y={0} width={width} height={height} />;
  };

  // Effect to set AI polygon when selection is complete
  useEffect(() => {
    if (isMouseOverStartPoint === true) {
      setAIPolygen(points);
    }
  }, [points, isMouseOverStartPoint, setAIPolygen]);

  // Get mouse position relative to stage
  const getMousePos = (stage: any): number[] => {
    const pos = stage.getPointerPosition();
    return [pos.x, pos.y];
  };

  // Handle click on image to add points or finish polygon
  const handleClick = (event: any) => {
    const stage = event.target.getStage();
    const mousePos = getMousePos(stage);

    dispatch(coordinatesSelected(isMouseOverStartPoint));
    if (isFinished) {
      return;
    }
    if (isMouseOverStartPoint && points.length >= 3) {
      setIsFinished(true);
    } else {
      setPoints([...points, mousePos]);
    }
  };

  // Handle mouse move to update current mouse position
  const handleMouseMove = (event: any) => {
    const stage = event.target.getStage();
    const mousePos = getMousePos(stage);
    setCurMousePos(mousePos);
  };

  // Handle mouse over start point to scale point and set state
  const handleMouseOverStartPoint = (event: any) => {
    if (isFinished || points.length < 3) return;
    event.target.scale({ x: 2, y: 2 });
    setIsMouseOverStartPoint(true);
  };

  // Handle mouse out from start point to reset scale and state
  const handleMouseOutStartPoint = (event: any) => {
    event.target.scale({ x: 1, y: 1 });
    setIsMouseOverStartPoint(false);
  };

  // Handle drag start of a point (optional logging)
  const handleDragStartPoint = (event: any) => {
    // console.log("start", event);
  };

  // Handle drag move of a point to update points array
  const handleDragMovePoint = (event: any) => {
    const index = event.target.index - 1;
    const pos = [event.target.attrs.x, event.target.attrs.y];
    setPoints([...points.slice(0, index), pos, ...points.slice(index + 1)]);
  };

  // Handle drag out of a point (optional logging)
  const handleDragOutPoint = (event: any) => {
    // console.log("end", event);
  };

  // Handle drag end of a point (optional logging)
  const handleDragEndPoint = (event: any) => {
    // console.log("end", event);
  };

  // Flatten points array and add current mouse position if drawing not finished
  const flattenedPoints = points
    .concat(isFinished ? [] : curMousePos)
    .reduce((a, b) => a.concat(b), []);

  return (
    <>
      <Stage
        width={width}
        height={height}
        onMouseDown={handleClick}
        onMouseMove={handleMouseMove}
        style={{
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: `${width}px ${height}px`,
          backgroundRepeat: "no-repeat",
        }}
      >
        <Layer>
          {/* <LionImage /> */}
          <Line
            points={flattenedPoints}
            stroke="yellow"
            strokeWidth={3}
            closed={isFinished}
          />

          {points.map((point, index) => {
            const width = 6;
            const x = point[0] - width / 2;
            const y = point[1] - width / 2;
            const startPointAttr =
              index === 0
                ? {
                    hitStrokeWidth: 12,
                    onMouseOver: handleMouseOverStartPoint,
                    onMouseOut: handleMouseOutStartPoint,
                  }
                : null;
            return (
              <Rect
                key={index}
                x={x}
                y={y}
                width={width}
                height={width}
                fill="white"
                stroke="yellow"
                strokeWidth={3}
                onDragStart={handleDragStartPoint}
                onDragMove={handleDragMovePoint}
                onDragEnd={handleDragEndPoint}
                draggable
                {...startPointAttr}
              />
            );
          })}
        </Layer>
      </Stage>
    </>
  );
};

export default React.memo(CanvasDraw);
