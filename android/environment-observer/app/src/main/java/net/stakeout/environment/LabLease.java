package net.stakeout.environment;
import java.util.UUID;
import java.util.function.LongConsumer;
/** Volatile, explicitly synthetic application test state. Does not alter Android radios. */
public final class LabLease {
  public static final class View {
    public final String session,frame;public final long epoch,sequence,expiresAt;
    View(String s,String f,long e,long q,long x){session=s;frame=f;epoch=e;sequence=q;expiresAt=x;}
  }
  private long highest,epoch,sequence=-1,sim=-1,expires,lastNow=-1;
  private String session,frame,lastClosed;private long lastClosedEpoch=-1;
  private final LongConsumer persistEpoch;
  public LabLease(long minimumEpoch,LongConsumer save){highest=minimumEpoch;persistEpoch=save;}
  private static void require(boolean v,String error){if(!v)throw new IllegalArgumentException(error);}
  private void tick(long now){require(now>=0&&now>=lastNow,"CLOCK_REGRESSION");lastNow=now;if(session!=null&&now>=expires){lastClosed=session;lastClosedEpoch=epoch;session=null;frame=null;}}
  private void identity(String id,long e){require(session!=null,"SESSION_EXPIRED");require(session.equals(id)&&epoch==e,"SESSION_MISMATCH");}
  public synchronized void open(String id,long e,long now){
    tick(now);require(id!=null&&UUID.fromString(id).toString().equals(id),"INVALID_SESSION");require(e>0&&e<=9007199254740991L,"INVALID_EPOCH");
    if(id.equals(session)&&e==epoch)return;
    require(e>highest,"EPOCH_REPLAY");persistEpoch.accept(e);highest=e;epoch=e;session=id;frame=null;sequence=-1;sim=-1;expires=now+10000;
  }
  public synchronized void stage(String id,long e,long q,long elapsed,String json,long leaseMs,long now){
    tick(now);identity(id,e);require(q>=0&&q<=9007199254740991L&&elapsed>=0&&elapsed<=9007199254740991L,"INVALID_SEQUENCE");
    require(json!=null&&json.length()<=90000&&leaseMs>=100&&leaseMs<=10000,"INVALID_LEASE_OR_FRAME");
    if(q==sequence){require(json.equals(frame)&&elapsed==sim,"SEQUENCE_COLLISION");return;}
    require(q>sequence,"SEQUENCE_REPLAY");require(elapsed>sim,"SIM_CLOCK_REGRESSION");
    sequence=q;sim=elapsed;frame=json;expires=now+leaseMs;
  }
  public synchronized void close(String id,long e,long now){tick(now);if(session==null&&id.equals(lastClosed)&&e==lastClosedEpoch)return;identity(id,e);lastClosed=session;lastClosedEpoch=epoch;session=null;frame=null;expires=0;}
  public synchronized View view(long now){tick(now);return new View(session,frame,epoch,sequence,expires);}
}
