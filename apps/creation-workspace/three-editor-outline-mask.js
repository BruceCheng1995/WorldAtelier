// Distances from raster pixel centres to the exterior of a filled silhouette.
// The square occupied by a covered sample extends half a texel on each side.
export function silhouetteDistances(pixels,w,h) {
  const length=w*h,exterior=new Uint8Array(length),queue=new Int32Array(length);
  let head=0,tail=0;
  function visit(index) {
    if(exterior[index] || pixels[index*4]>127)return;
    exterior[index]=1;queue[tail++]=index;
  }
  for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}
  for(let y=0;y<h;y++){visit(y*w);visit((y+1)*w-1);}
  while(head<tail){
    const i=queue[head++],x=i%w;
    if(x)visit(i-1);if(x+1<w)visit(i+1);
    if(i>=w)visit(i-w);if(i+w<length)visit(i+w);
  }

  // First minimize the horizontal distance on each scanline. Empty pixels
  // enclosed by mesh coverage are interior, as in the native filled polygons.
  const horizontal=new Float32Array(length);
  for(let y=0;y<h;y++){
    const row=y*w;let nearest=-Infinity;
    for(let x=0;x<w;x++){
      const i=row+x;if(!exterior[i])nearest=x;
      horizontal[i]=exterior[i]?(x-nearest-.5)**2:0;
    }
    nearest=Infinity;
    for(let x=w-1;x>=0;x--){
      const i=row+x;if(!exterior[i])nearest=x;
      else horizontal[i]=Math.min(horizontal[i],(nearest-x-.5)**2);
    }
  }
  // In the vertical direction use the lower envelope of squared distances
  // to the near edge of each row of filled pixels. Each parabola enters and
  // leaves the envelope at most once per pass, independent of outline width.
  const distance=horizontal.slice(),centres=new Int32Array(h),starts=new Float64Array(h);
  for(let x=0;x<w;x++)for(let rev=0;rev<2;rev++){
    let first=0,end=0;
    const at=i=>(rev?h-1-i:i)*w+x;
    for(let y=0;y<h;y++){
      while(first+1<end&&starts[first+1]<=y)first++;
      if(first<end){
        const seed=centres[first];distance[at(y)]=Math.min(distance[at(y)],horizontal[at(seed)]+(y-seed-.5)**2);
      }
      const base=horizontal[at(y)];if(!Number.isFinite(base))continue;
      let intersection=-Infinity;
      while(first<end){
        const previous=centres[end-1];
        intersection=(base-horizontal[at(previous)])/(2*(y-previous))+(y+previous+1)*.5;
        if(intersection>starts[end-1])break;
        end--;
      }
      starts[end]=first<end?intersection:-Infinity;centres[end++]=y;
    }
  }
  return distance;
}
