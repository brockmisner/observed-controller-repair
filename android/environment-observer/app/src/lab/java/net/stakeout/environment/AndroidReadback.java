package net.stakeout.environment;
import android.content.Context;
import org.json.JSONObject;
/** Compile-time lab boundary: no Android radio/location readback code in this flavor. */
final class AndroidReadback implements AutoCloseable {
  AndroidReadback(Context context){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  JSONObject location(){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  JSONObject wifi(){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  JSONObject cells(){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  JSONObject bluetooth(){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  void requestScans(){throw new IllegalStateException("LAB_HAS_NO_READBACK");}
  public void close(){}
}
