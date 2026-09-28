import React from 'react';
import Loading from "../../assets/images/loading.gif";

const styles = {
  centerFlex: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    minHeight: '260px',       
  } as React.CSSProperties,

  dataNotFound: {
    textAlign: 'center' as const,
    position: 'relative' as const,
    zIndex: 1,                
  } as React.CSSProperties,

  h2: {
    fontWeight: 600,
    marginTop: 12,
    paddingLeft: 0,           
  } as React.CSSProperties,

  img: {
    width: 64,                
    height: 64,
  } as React.CSSProperties,
};

const VideoGeneration: React.FC = () => {
  return (
    <div style={styles.centerFlex}>
      <div style={styles.dataNotFound}>
        <img alt="loading" src={Loading} style={styles.img} />
        <h2 style={styles.h2}>Video is being generated</h2>
      </div>
    </div>
  );
};

export default VideoGeneration;
