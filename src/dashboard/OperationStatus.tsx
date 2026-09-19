import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

interface Operation { status:string; requested_at:string; run_id:string|null; message:string; }
export function OperationStatus() {
  const {operationId = ""} = useParams();
  const [refresh,setRefresh] = useState(0);
  const [state,setState] = useState<{loading:boolean;operation?:Operation;message?:string}>({loading:true});
  useEffect(()=>{
    const controller = new AbortController();
    setState({loading:true});
    void fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`,{signal:controller.signal,cache:"no-store"})
      .then(async(response)=>{
        const data = await response.json() as Operation & {error?:string};
        if (!controller.signal.aborted) setState(response.ok?{loading:false,operation:data}:{loading:false,message:data.error??"Status is unavailable. Try again later."});
      }).catch(()=>{if(!controller.signal.aborted)setState({loading:false,message:"Status is unavailable. Try again later."});});
    return ()=>controller.abort();
  },[operationId,refresh]);
  return <section className="page-section"><header className="page-heading"><p className="eyebrow">Background request</p><h1>Automatic startup recovery</h1><p>Accepted requests resume after temporary limits reset. You do not need to keep this page open.</p></header>
    <article className="panel" role="status"><h2>{state.loading?"Checking status…":state.operation?.status??"Awaiting a status record"}</h2>
      <p>{state.operation?.message??state.message}</p>
      {state.operation && <p>Requested: {new Date(state.operation.requested_at).toLocaleString()}</p>}
      {state.operation?.run_id && <p><Link to={`/reports/${state.operation.run_id}`}>Open report progress</Link></p>}
      <button type="button" disabled={state.loading} onClick={()=>setRefresh((value)=>value+1)}>Refresh status</button>
    </article></section>;
}
