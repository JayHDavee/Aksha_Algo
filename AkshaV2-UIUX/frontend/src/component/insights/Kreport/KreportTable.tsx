import React, { useState } from "react";
import "./styles/kpiReportTable.scss";
import ImageZoomModal from "../../common/ImageZoomModal";


interface KPIRecord {
  timestamp: string;
  counts: Record<string, number>;
  frame_link?: string;
}

interface KPICameraReport {
  camera_name: string;
  records: KPIRecord[];
}

interface KPIReportTableProps {
  data: KPICameraReport[];
  selectedOOILabels: string[];
}



const KPIReportTable: React.FC<KPIReportTableProps> = ({
  data,
  selectedOOILabels,
}) => {
  const [expandedCamera, setExpandedCamera] = useState<string | null>(null);
  const [currentImg, setCurrentImg] = useState<string | null>(null);
  const [openImgModal, setOpenImgModal] = useState<boolean>(false);

  const toggleCamera = (name: string) =>
    setExpandedCamera(expandedCamera === name ? null : name);

 const formatCounts = (
  countsObj?: Record<string, number>,
  labels: string[] = []
): string => {
  if (!countsObj) return "-";

  const normalizedLabels = labels.map(l =>
    l.toLowerCase().trim()
  );

  const entries = Object.entries(countsObj)
    .filter(([key, value]) =>
      normalizedLabels.length
        ? normalizedLabels.includes(key.toLowerCase()) && value > 0
        : value > 0
    )
    .map(([k, v]) => `${k}: ${v}`);

  return entries.length ? entries.join(", ") : "-";
};


   
  return (
    <>
      <div className="kpi-table-wrapper">
        <table className="kpi-table">
          <thead>
            <tr>
              <th>Camera</th>
              <th>Date</th>
              <th>Time</th>
              <th>Counts</th>
              <th>Image</th>
            </tr>
          </thead>

          <tbody>
            {data.map((cam) => {
              const latest = cam.records?.[0];
              const isExpanded = expandedCamera === cam.camera_name;

              return (
                <React.Fragment key={cam.camera_name}>
                  <tr
                    className="camera-row"
                    onClick={() => toggleCamera(cam.camera_name)}
                  >
                    <td>{isExpanded ? "▼" : "▶"} <b>{cam.camera_name}</b></td>
                    <td>{latest ? new Date(latest.timestamp).toLocaleDateString("en-GB") : "-"}</td>
                    <td>{latest ? new Date(latest.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                    <td>{formatCounts(latest?.counts, selectedOOILabels)}</td>
                    <td>
                      {latest?.frame_link ? (
                        <span
                          className="image-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCurrentImg(latest.frame_link!);
                            setOpenImgModal(true);
                          }}
                        >
                          View Image ↗
                        </span>
                      ) : "-"}
                    </td>
                  </tr>

                  {isExpanded &&
                    cam.records.slice(1).map((rec, idx) => (
                      <tr key={idx} className="frame-row">
                        <td />
                        <td>{new Date(rec.timestamp).toLocaleDateString("en-GB")}</td>
                        <td>{new Date(rec.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                        <td>{formatCounts(rec.counts, selectedOOILabels)}</td>
                        <td>
                          {rec.frame_link ? (
                            <span
                              className="image-link"
                              onClick={() => {
                                setCurrentImg(rec.frame_link!);
                                setOpenImgModal(true);
                              }}
                            >
                              View Image ↗
                            </span>
                          ) : "-"}
                        </td>
                      </tr>
                    ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {openImgModal && currentImg && (
        <ImageZoomModal
          isOpen={openImgModal}
          imageSrc={currentImg}
          onClose={() => setOpenImgModal(false)}
        />
      )}
    </>
  );
};

export default KPIReportTable;
