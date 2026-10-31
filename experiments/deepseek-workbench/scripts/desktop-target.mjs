/** Recovery is for unavailable engine/web only, never for rejected ownership or vault checks. */
export async function desktopTarget({engineAvailable,start,authenticate}){
 if(!await engineAvailable())return {url:'',recovery:true};
 await start();
 try{return {url:await authenticate(),recovery:false};}
 catch{return {url:'',recovery:true};}
}

/** Normal launch may start only the already-known stopped Windows engine. */
export async function desktopEngineAvailable({recovery=false,ensure}){
 if(recovery)return false;
 try{await ensure();return true;}
 catch{return false;}
}
