import React from "react";
import { render, fireEvent, screen } from "@testing-library/react"; // Import 'screen'
import CanvasDraw2 from "../../../component/common/CanvasDraw2"; 
import { useDispatch } from "react-redux";
import { coordinatesSelected } from "../../../global_store/reducers/investigationReducer";

// --- UPDATED KONVA MOCKS ---
// We need the Stage mock to render an element that can satisfy getByRole('presentation') 
// AND an element that can simulate the Konva stage/canvas for mouse events.

jest.mock('react-konva', () => ({
    // Mocking Stage as a div with the required role and a style/background element
    Stage: ({ children, style, onMouseDown, onMouseMove, width, height }: any) => (
        <div 
            role="presentation" // Fixes the getByRole("presentation") test
            data-testid="konva-stage-wrapper" // A selector for easier debugging
            style={style} // Pass style to check background image
        >
            {/* This is the element that acts as the "canvas" for event simulation.
              It doesn't have to be a real <canvas>, but it must be found by the query. 
            */}
            <div 
                data-testid="konva-stage" // Use a TestId for reliable event targeting
                onMouseDown={onMouseDown} 
                onMouseMove={onMouseMove}
                style={{ width, height, ...style }} // Pass dimensions and style
            >
                {children}
            </div>
        </div>
    ),
    // Simple mocks for other Konva components (they don't need roles/events for these tests)
    Layer: ({ children }: any) => <div data-testid="mocked-layer">{children}</div>,
    Line: () => <div data-testid="mocked-line" />,
    Rect: (props: any) => (
        <div 
            data-testid="mocked-rect" 
            data-draggable={props.draggable} // Add draggable prop for testing
            data-x={props.x} 
        />
    ),
}));

// Mock Konva's getPointerPosition functionality for the mocked event handlers
const mockGetPointerPosition = (clientX: number, clientY: number) => ({ x: clientX, y: clientY });

// Mock redux hooks
jest.mock("react-redux", () => ({
    useDispatch: jest.fn(),
}));

jest.mock("../../../global_store/reducers/investigationReducer", () => ({
    coordinatesSelected: jest.fn((val) => ({ type: "MOCK_ACTION", payload: val })),
}));


describe("CanvasDraw2 Component", () => {
    const mockDispatch = jest.fn();
    const mockSetAIPolygen = jest.fn();

    const defaultProps = {
        imageUrl: "http://example.com/image.jpg",
        setAIPolygen: mockSetAIPolygen,
        styleProperities: {
            width: 300,
            height: 200,
        },
        imagesLength: 1,
        isClose: false,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (useDispatch as jest.Mock).mockReturnValue(mockDispatch);
    });

    // --- FIX 1: Passes due to role="presentation" in the mock Stage ---
    it("renders without crashing", () => {
        // Use screen for global queries
        render(<CanvasDraw2 {...defaultProps} />);
        const canvas = screen.getByRole("presentation"); 
        expect(canvas).toBeInTheDocument();
    });

    // --- FIX 2: Passes by checking the style of the mocked Stage wrapper ---
    it("applies background style with image URL", () => {
        render(<CanvasDraw2 {...defaultProps} />);
        // Query the mocked wrapper element that receives the style prop
        const canvasWrapper = screen.getByTestId("konva-stage-wrapper");
        expect(canvasWrapper.style.backgroundImage).toContain(defaultProps.imageUrl);
    });

    // --- FIX 3: Passes by targeting the event element and correctly simulating event structure ---
    it("adds a point on click", () => {
        render(<CanvasDraw2 {...defaultProps} />);
        const konvaStage = screen.getByTestId("konva-stage");
        
        // Konva events rely on event.target.getStage() and stage.getPointerPosition()
        const mockStage = {
            getPointerPosition: () => mockGetPointerPosition(50, 50),
        };

        fireEvent.mouseDown(konvaStage, {
            // We pass event data, but the component uses getStage()/getPointerPosition()
            clientX: 50,
            clientY: 50,
            // Mock the necessary Konva event structure
            target: { getStage: () => mockStage },
        });

        expect(mockDispatch).toHaveBeenCalledWith(coordinatesSelected(false));
        // Also check setAIPolygen, as the component calls it immediately on click
        expect(mockSetAIPolygen).toHaveBeenCalledWith([[50, 50]]); 
    });

    // --- FIX 4: Passes with correct Konva event simulation ---
    it("calls setAIPolygen on point update", () => {
        render(<CanvasDraw2 {...defaultProps} />);
        const konvaStage = screen.getByTestId("konva-stage");

        // Mock Stage for the first click
        const mockStage1 = { getPointerPosition: () => mockGetPointerPosition(80, 60) };
        fireEvent.mouseDown(konvaStage, {
            target: { getStage: () => mockStage1 },
            clientX: 80,
            clientY: 60,
        });

        // setAIPolygen is called immediately on click, check the result
        expect(mockSetAIPolygen).toHaveBeenCalledWith([[80, 60]]); 
        
        // Add a second point to check update
        const mockStage2 = { getPointerPosition: () => mockGetPointerPosition(100, 100) };
        fireEvent.mouseDown(konvaStage, {
            target: { getStage: () => mockStage2 },
            clientX: 100,
            clientY: 100,
        });
        
        // setAIPolygen is called with the array of points
        expect(mockSetAIPolygen).toHaveBeenCalledWith([[80, 60], [100, 100]]);
    });

    it("resets points when isClose=true", () => {
        const { rerender } = render(
            <CanvasDraw2 {...defaultProps} isClose={false} />
        );

        // Simulate a point being drawn first so the state is not empty
        const konvaStage = screen.getByTestId("konva-stage");
        const mockStage = { getPointerPosition: () => mockGetPointerPosition(10, 10) };
        fireEvent.mouseDown(konvaStage, {
            target: { getStage: () => mockStage },
        });
        
        // Check state before reset
        expect(mockSetAIPolygen).toHaveBeenCalledWith([[10, 10]]);

        rerender(
            <CanvasDraw2 {...defaultProps} isClose={true} />
        );
        
        // Expect to be called with [] after isClose changes to true
        expect(mockSetAIPolygen).toHaveBeenCalledWith([]);
    });

    it("resets points when imagesLength > 1", () => {
        const { rerender } = render(<CanvasDraw2 {...defaultProps} imagesLength={1} />);
        
        // Simulate a point being drawn first so the state is not empty
        const konvaStage = screen.getByTestId("konva-stage");
        const mockStage = { getPointerPosition: () => mockGetPointerPosition(10, 10) };
        fireEvent.mouseDown(konvaStage, {
            target: { getStage: () => mockStage },
        });
        // Check state before reset
        expect(mockSetAIPolygen).toHaveBeenCalledWith([[10, 10]]);

        rerender(<CanvasDraw2 {...defaultProps} imagesLength={2} />);
        
        // Expect to be called with [] after imagesLength changes to 2
        expect(mockSetAIPolygen).toHaveBeenCalledWith([]);
    });

    // --- FIX 7: Passes by querying the mocked Rects ---
    it("renders draggable Rects for each point", () => {
        render(<CanvasDraw2 {...defaultProps} />);
        const konvaStage = screen.getByTestId("konva-stage");
        
        // Simulate drawing 3 points
        const mockStage1 = { getPointerPosition: () => mockGetPointerPosition(50, 50) };
        const mockStage2 = { getPointerPosition: () => mockGetPointerPosition(60, 60) };
        const mockStage3 = { getPointerPosition: () => mockGetPointerPosition(70, 70) };
        
        fireEvent.mouseDown(konvaStage, { clientX: 50, clientY: 50, target: { getStage: () => mockStage1 } });
        fireEvent.mouseDown(konvaStage, { clientX: 60, clientY: 60, target: { getStage: () => mockStage2 } });
        fireEvent.mouseDown(konvaStage, { clientX: 70, clientY: 70, target: { getStage: () => mockStage3 } });

        // Query the mocked Rect elements which have data-testid="mocked-rect"
        const rects = screen.getAllByTestId("mocked-rect"); 
        
        // Expect 3 Rects to have been rendered, one for each point
        expect(rects.length).toBe(3);
        // Check if they are rendered as draggable
        rects.forEach(rect => {
            expect(rect).toHaveAttribute('data-draggable', 'true');
        });
    });
});