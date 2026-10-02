package net.stakeout.environment;

import org.json.JSONObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.security.*;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** One authenticated request per fresh server nonce, over an ADB loopback tunnel. */
final class Wire {
  static final int MAX_BYTES=131072;
  static final String PROTOCOL="stakeout.environment";
  private static final SecureRandom RANDOM=new SecureRandom();
  static String nonce(){byte[] bytes=new byte[32];RANDOM.nextBytes(bytes);return hex(bytes);}
  static String hex(byte[] value){StringBuilder b=new StringBuilder();for(byte x:value)b.append(String.format(Locale.ROOT,"%02x",x&255));return b.toString();}
  static byte[] unhex(String s){if(s==null||!s.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("INVALID_KEY");byte[] b=new byte[32];for(int i=0;i<32;i++)b[i]=(byte)Integer.parseInt(s.substring(i*2,i*2+2),16);return b;}
  static String sign(String key,String nonce,String direction,String payload)throws Exception{
    if(!nonce.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("INVALID_NONCE");
    Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(unhex(key),"HmacSHA256"));
    return hex(mac.doFinal((direction+"\n"+nonce+"\n"+payload).getBytes(StandardCharsets.UTF_8)));
  }
  static JSONObject read(InputStream in)throws Exception{
    ByteArrayOutputStream b=new ByteArrayOutputStream();int c;
    while((c=in.read())!=-1&&c!='\n'){if(b.size()>=MAX_BYTES-1)throw new IOException("FRAME_TOO_LARGE");b.write(c);}
    if(c<0)throw new EOFException("INCOMPLETE_FRAME");
    String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b.toByteArray())).toString();
    return new JSONObject(text);
  }
  static void write(OutputStream out,JSONObject value)throws Exception{
    byte[] bytes=(value.toString()+"\n").getBytes(StandardCharsets.UTF_8);if(bytes.length>MAX_BYTES)throw new IOException("FRAME_TOO_LARGE");out.write(bytes);out.flush();
  }
  static void fields(JSONObject value,String... names){
    Set<String> allowed=new HashSet<>(Arrays.asList(names));Iterator<String> i=value.keys();while(i.hasNext())if(!allowed.contains(i.next()))throw new IllegalArgumentException("UNKNOWN_FIELD");
  }
  static String string(JSONObject o,String field,int max)throws Exception{
    Object v=o.get(field);if(!(v instanceof String)||((String)v).isEmpty()||((String)v).length()>max)throw new IllegalArgumentException("INVALID_FIELD");return (String)v;
  }
  static long integer(JSONObject o,String field,long min,long max)throws Exception{
    Object v=o.get(field);if(!(v instanceof Number))throw new IllegalArgumentException("INVALID_NUMBER");double n=((Number)v).doubleValue();if(!Double.isFinite(n)||n<min||n>max||n!=Math.floor(n))throw new IllegalArgumentException("INVALID_NUMBER");return (long)n;
  }
  static JSONObject authenticate(JSONObject wire,String key,String nonce)throws Exception{
    fields(wire,"version","payload","mac");if(integer(wire,"version",1,1)!=1)throw new IllegalArgumentException("INVALID_VERSION");
    String payload=string(wire,"payload",MAX_BYTES),signature=string(wire,"mac",64);
    if(!signature.matches("[a-f0-9]{64}")||!MessageDigest.isEqual(unhex(signature),unhex(sign(key,nonce,"request",payload))))throw new SecurityException("AUTH_FAILED");
    return new JSONObject(payload);
  }
  static JSONObject signed(JSONObject response,String key,String nonce)throws Exception{
    String payload=response.toString();return new JSONObject().put("version",1).put("payload",payload).put("mac",sign(key,nonce,"response",payload));
  }
}
